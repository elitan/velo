import chalk from 'chalk';
import { generateUUID } from '../../utils/helpers';
import type { Branch } from '../../types/state';
import { parseNamespace, getMainBranch } from '../../utils/namespace';
import { parseRecoveryTime, formatDate } from '../../utils/time';
import { Rollback } from '../../utils/rollback';
import { UserError } from '../../errors';
import { withProgress } from '../../utils/progress';
import { getContainerName, getDatasetName, getDatasetPath } from '../../utils/naming';
import { getPublicIP, formatConnectionString } from '../../utils/network';
import { initializeServices, getBranchWithProject } from '../../utils/service-factory';
import { selectSnapshotForPITR } from '../../services/pitr-service';
import { createApplicationConsistentSnapshot } from '../../services/snapshot-service';

export interface BranchCreateOptions {
  parent?: string;
  pitr?: string;  // Point-in-time recovery target
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

  const { state, zfs, docker, wal, stateData } = await initializeServices();

  // Find source project and branch
  const { branch: sourceBranch, project: sourceProject } = await getBranchWithProject(state, source.full);

  // Check if target already exists
  const existingBranch = sourceProject.branches.find(b => b.name === target.full);
  if (existingBranch) {
    throw new UserError(`Branch '${target.full}' already exists`);
  }

  // Setup rollback for cleanup on failure
  const rollback = new Rollback();

  // Compute source branch names
  const sourceNamespace = parseNamespace(source.full);
  const sourceContainerName = getContainerName(sourceNamespace.project, sourceNamespace.branch);
  const sourceDatasetName = getDatasetName(sourceNamespace.project, sourceNamespace.branch);
  const sourceDatasetPath = getDatasetPath(stateData.zfsPool, stateData.zfsDatasetBase, sourceNamespace.project, sourceNamespace.branch);

  // Determine snapshot to use
  let fullSnapshotName: string;
  let snapshotName: string;
  let createdSnapshot = false;

  if (options.pitr && recoveryTarget) {
    // PITR: select existing snapshot before recovery target
    const selection = await selectSnapshotForPITR(source.full, recoveryTarget, state);
    fullSnapshotName = selection.fullSnapshotName;
    snapshotName = selection.snapshotName;
  } else {
    // Non-PITR: create new application-consistent snapshot
    const result = await createApplicationConsistentSnapshot({
      datasetName: sourceDatasetName,
      datasetPath: sourceDatasetPath,
      branchStatus: sourceBranch.status,
      containerName: sourceContainerName,
      username: sourceProject.credentials.username,
      zfs,
      docker,
    });
    snapshotName = result.snapshotName;
    fullSnapshotName = result.fullSnapshotName;
    createdSnapshot = true;
  }

  // Clone snapshot - use consistent <project>-<branch> naming
  const targetDatasetName = getDatasetName(target.project, target.branch);
  const targetDatasetPath = getDatasetPath(stateData.zfsPool, stateData.zfsDatasetBase, target.project, target.branch);
  const targetContainerName = getContainerName(target.project, target.branch);
  let mountpoint: string;
  let port: number;
  let containerID: string | undefined;

  try {
    await withProgress('Clone dataset', async () => {
      await zfs.cloneSnapshot(fullSnapshotName, targetDatasetName);
    });

    // Rollback: destroy cloned dataset
    rollback.add(async () => {
      await zfs.destroyDataset(targetDatasetName, true).catch(() => {});
    });

    // Rollback: destroy snapshot if we created it (not for PITR which uses existing snapshots)
    if (createdSnapshot) {
      rollback.add(async () => {
        await zfs.destroySnapshot(fullSnapshotName).catch(() => {});
      });
    }

    // Mount the dataset (requires sudo on Linux due to kernel restrictions)
    await withProgress('Mount dataset', async () => {
      await zfs.mountDataset(targetDatasetName);
    });

    mountpoint = await zfs.getMountpoint(targetDatasetName);

    // Use port 0 to let Docker dynamically assign an available port
    port = 0;

    // Pull image if needed (use project's docker image)
    const dockerImage = sourceProject.dockerImage;
    const imageExists = await docker.imageExists(dockerImage);
    if (!imageExists) {
      await withProgress(`Pull ${dockerImage}`, async () => {
        await docker.pullImage(dockerImage);
      });
    }

    // Create WAL archive directory for target branch (delete any leftover archives first)
    await wal.deleteArchiveDir(targetDatasetName);
    await wal.ensureArchiveDir(targetDatasetName);
    const targetWALArchivePath = wal.getArchivePath(targetDatasetName);

    // Determine which WAL archive to mount
    let walArchivePath = targetWALArchivePath;

    // If PITR is requested, setup recovery configuration
    if (recoveryTarget) {
      await withProgress('Configure PITR recovery', async () => {
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
    containerID = await withProgress(containerLabel, async () => {
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
      });

      // Rollback: remove container
      rollback.add(async () => {
        await docker.removeContainer(id).catch(() => {});
      });

      await docker.startContainer(id);
      await docker.waitForHealthy(id);

      return id;
    });

    // Get the dynamically assigned port from Docker
    port = await docker.getContainerPort(containerID);

    const sizeBytes = await zfs.getUsedSpace(targetDatasetName);

    const branch: Branch = {
      id: generateUUID(),
      name: target.full,
      projectName: target.project,
      parentBranchId: sourceBranch.id,
      isPrimary: false,
      snapshotName: fullSnapshotName,
      zfsDataset: targetDatasetName,
      port,
      createdAt: new Date().toISOString(),
      sizeBytes,
      status: 'running',
    };

    await state.branches.add(sourceProject.id, branch);

    // Success! Clear rollback steps
    rollback.clear();
  } catch (error) {
    // Operation failed, rollback all created resources
    console.log();
    console.log('Operation failed, cleaning up...');
    await rollback.execute();
    throw error;
  }

  // Get public IP for remote connection info
  const publicIP = await getPublicIP();

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
