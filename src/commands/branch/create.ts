import chalk from 'chalk';
import { generateUUID } from '../../utils/helpers';
import type { Branch } from '../../types/state';
import { parseNamespace, getMainBranch } from '../../utils/namespace';
import { parseRecoveryTime, formatDate } from '../../utils/time';
import { UserError } from '../../errors';
import { getBranchContainerName, getContainerName, getDatasetName, getDatasetPathFromName } from '../../utils/naming';
import { getPublicIPForBranch, formatConnectionString } from '../../utils/network';
import { initializeServices, getBranchWithProject } from '../../utils/service-factory';
import { selectSnapshotForPITR } from '../../services/pitr-service';
import { createApplicationConsistentSnapshot } from '../../services/snapshot-service';
import { OperationRunner } from '../../utils/operation-runner';

export interface BranchCreateOptions {
  parent?: string;
  pitr?: string;  // Point-in-time recovery target
  public?: boolean;
}

export async function branchCreateCommand(targetName: string, options: BranchCreateOptions = {}) {
  // Parse target namespace
  const target = parseNamespace(targetName);

  // Determine source (parent)
  let sourceName: string;
  if (options.parent) {
    sourceName = options.parent;
  } else {
    // Default to <project>/main
    sourceName = getMainBranch(target.project);
  }

  const source = parseNamespace(sourceName);

  // Validate source and target are in same project
  if (source.project !== target.project) {
    throw new UserError(
      `Source and target must be in the same project`,
      `Source: ${source.project}, Target: ${target.project}`
    );
  }

  // Parse PITR target if provided
  let recoveryTarget: Date | undefined;

  console.log();
  console.log(`Creating ${chalk.bold(target.full)} from ${chalk.bold(source.full)}...`);

  if (options.pitr) {
    recoveryTarget = parseRecoveryTime(options.pitr);
    console.log();
    console.log(chalk.dim(`  Recovery target: ${formatDate(recoveryTarget)}`));
  }

  const { state, zfs, docker, wal, resources, stateData } = await initializeServices();

  // Find source project and branch
  const { branch: sourceBranch, project: sourceProject } = await getBranchWithProject(state, source.full);

  // Check if target already exists
  const existingBranch = sourceProject.branches.find(b => b.name === target.full);
  if (existingBranch) {
    throw new UserError(`Branch '${target.full}' already exists`);
  }

  const operation = new OperationRunner();

  const sourceContainerName = getBranchContainerName(sourceBranch);
  const sourceDatasetName = sourceBranch.zfsDataset;
  const sourceDatasetPath = getDatasetPathFromName(stateData.zfsPool, stateData.zfsDatasetBase, sourceDatasetName);

  let fullSnapshotName = '';

  const targetDatasetName = getDatasetName(target.project, target.branch);
  const targetContainerName = getContainerName(target.project, target.branch);
  let mountpoint: string;
  let port = 0;
  let containerID: string | undefined;
  let branch: Branch | null = null;

  await operation.run(async function runOperation() {
    if (options.pitr && recoveryTarget) {
      const selection = await selectSnapshotForPITR(source.full, recoveryTarget, state);
      fullSnapshotName = selection.fullSnapshotName;
    } else {
      const result = await createApplicationConsistentSnapshot({
        datasetName: sourceDatasetName,
        datasetPath: sourceDatasetPath,
        branchStatus: sourceBranch.status,
        containerName: sourceContainerName,
        username: sourceProject.credentials.username,
        zfs,
        docker,
      });
      fullSnapshotName = result.fullSnapshotName;
      operation.addRollback(async function rollbackSnapshot() {
        await zfs.destroySnapshot(fullSnapshotName);
      });
    }

    await operation.step('Clone dataset', async function cloneDataset() {
      await zfs.cloneSnapshot(fullSnapshotName, targetDatasetName);
    }, async function rollbackDataset() {
      await resources.destroyDataset(targetDatasetName);
    });

    // Mount the dataset (requires sudo on Linux due to kernel restrictions)
    await operation.step('Mount dataset', async function mountDataset() {
      await zfs.mountDataset(targetDatasetName);
    });

    mountpoint = await zfs.getMountpoint(targetDatasetName);

    // Use port 0 to let Docker dynamically assign an available port
    port = 0;

    // Pull image if needed (use project's docker image)
    const dockerImage = sourceProject.dockerImage;
    const imageExists = await docker.imageExists(dockerImage);
    if (!imageExists) {
      await operation.step(`Pull ${dockerImage}`, async function pullImage() {
        await docker.pullImage(dockerImage);
      });
    }

    const targetWALArchivePath = await operation.step('Prepare WAL archive', async function prepareWalArchive() {
      return await resources.recreateWalArchive(targetDatasetName);
    }, async function rollbackWalArchive() {
      await resources.deleteWalArchive(targetDatasetName);
    });

    // Determine which WAL archive to mount
    let walArchivePath = targetWALArchivePath;

    // If PITR is requested, setup recovery configuration
    if (recoveryTarget) {
      await operation.step('Configure PITR recovery', async function configurePitrRecovery() {
        // Get source WAL archive path (shared across all branches of same project)
        const sourceWALArchivePath = wal.getArchivePath(sourceDatasetName);

        // Setup recovery configuration in the cloned dataset
        await wal.setupPITRecovery(mountpoint, sourceWALArchivePath, recoveryTarget);

        // For PITR recovery, mount the SOURCE WAL archive so PostgreSQL can read archived WAL files
        walArchivePath = sourceWALArchivePath;
      });
    }

    // Create and start container
    const containerLabel = recoveryTarget ? 'PostgreSQL WAL replay' : 'PostgreSQL ready';
    containerID = await operation.step(containerLabel, async function startPostgres() {
      const id = await docker.createContainer({
        name: targetContainerName,
        image: dockerImage,
        port,
        dataPath: mountpoint,
        walArchivePath,
        sslCertDir: sourceProject.sslCertDir,
        password: sourceProject.credentials.password,
        username: sourceProject.credentials.username,
        database: sourceProject.credentials.database,
        publicAccess: options.public === true,
      });

      operation.addRollback(async function rollbackContainer() {
        await docker.removeContainer(id);
      });

      await docker.startContainer(id);
      await docker.waitForHealthy(id);

      return id;
    });

    // Get the dynamically assigned port from Docker
    port = await docker.getContainerPort(containerID);

    const sizeBytes = await zfs.getUsedSpace(targetDatasetName);

    branch = {
      id: generateUUID(),
      name: target.full,
      projectName: target.project,
      parentBranchId: sourceBranch.id,
      isPrimary: false,
      snapshotName: fullSnapshotName,
      zfsDataset: targetDatasetName,
      containerName: targetContainerName,
      port,
      createdAt: new Date().toISOString(),
      sizeBytes,
      status: 'running',
      publicAccess: options.public === true,
    };

    await state.branches.add(sourceProject.id, branch);
  });

  if (!branch) {
    throw new UserError('Branch state was not created');
  }

  const publicIP = await getPublicIPForBranch(branch);

  console.log();
  console.log(chalk.bold(`Branch '${target.full}' created`));
  console.log();
  console.log(chalk.bold('Connection:'));
  console.log(formatConnectionString(
    sourceProject.credentials.username,
    sourceProject.credentials.password,
    port,
    sourceProject.credentials.database,
    publicIP
  ));
  console.log();
}
