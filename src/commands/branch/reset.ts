import chalk from 'chalk';
import { createApplicationConsistentSnapshot } from '../../services/snapshot-service';
import { getBranchContainerName, getDatasetPathFromName } from '../../utils/naming';
import { UserError } from '../../errors';
import { withProgress } from '../../utils/progress';
import { getPublicIPForBranch, formatConnectionString } from '../../utils/network';
import { CLI_NAME } from '../../config/constants';
import { initializeServices, getBranchWithProject } from '../../utils/service-factory';
import { OperationRunner } from '../../utils/operation-runner';
import { replaceBranchDataset } from '../../services/branch-reset-service';

export async function branchResetCommand(name: string, options: { force?: boolean } = {}) {
  const { state, docker, zfs, wal, resources, stateData } = await initializeServices();
  const { branch, project } = await getBranchWithProject(state, name);

  // Prevent resetting main branch
  if (branch.isPrimary) {
    throw new UserError(
      `Cannot reset main branch. Main branch has no parent.`,
      `Main branches cannot be reset as they have no parent to reset from`
    );
  }

  // Find parent branch
  const parentBranch = project.branches.find(b => b.id === branch.parentBranchId);
  if (!parentBranch) {
    throw new UserError(
      `Parent branch not found for '${name}'`,
      `The parent branch may have been deleted`
    );
  }

  // Check for dependent branches (branches that have this branch as parent)
  const dependentBranches = project.branches.filter(b => b.parentBranchId === branch.id);
  if (dependentBranches.length > 0 && !options.force) {
    const dependentNames = dependentBranches.map(b => `  • ${b.name}`).join('\n');
    throw new UserError(
      `Cannot reset '${name}' - the following branches depend on it:\n\n` +
      `${dependentNames}\n\n` +
      `Resetting will destroy all dependent branches due to ZFS clone dependencies.\n` +
      `Either delete the dependent branches first, or use ${chalk.bold('--force')} to proceed anyway.\n\n` +
      `Warning: Using ${chalk.bold('--force')} will permanently delete all dependent branches!`
    );
  }

  console.log();
  console.log(`Resetting ${chalk.bold(name)} to ${chalk.bold(parentBranch.name)}...`);

  if (dependentBranches.length > 0 && options.force) {
    console.log();
    console.log('Warning: Force reset enabled!');
    console.log('The following dependent branches will be destroyed:');
    dependentBranches.forEach(b => {
      console.log(`  • ${b.name}`);
    });
  }

  console.log();

  // Compute parent branch names
  const parentContainerName = getBranchContainerName(parentBranch);
  const parentDatasetName = parentBranch.zfsDataset;
  const parentDatasetPath = getDatasetPathFromName(stateData.zfsPool, stateData.zfsDatasetBase, parentDatasetName);

  // Compute current branch names
  const containerName = getBranchContainerName(branch);
  const datasetName = branch.zfsDataset;
  const originalBranch = { ...branch };
  const originalSnapshots = state.snapshots.getForBranch(branch.name);

  // If force reset, clean up dependent branches first
  if (dependentBranches.length > 0 && options.force) {
    await withProgress('Clean up dependent branches', async () => {
      for (const depBranch of dependentBranches) {
        await resources.stopAndRemoveBranchContainer(depBranch);
        await resources.deleteBranchWalArchive(depBranch);

        // Clean up snapshots from state
        await state.snapshots.deleteForBranch(depBranch.name);

        // Remove branch from state (will be destroyed with ZFS dataset)
        await state.branches.delete(project.id, depBranch.id);
      }
    });
  }

  const operation = new OperationRunner();
  let fullSnapshotName = '';
  const tempDatasetName = `${datasetName}-temp`;
  const backupDatasetName = `${datasetName}-old`;
  let mountpoint = await zfs.getMountpoint(datasetName);
  let walArchivePath = wal.getArchivePath(datasetName);
  let newContainerID = '';

  await operation.run(async function runOperation() {
    const oldMountpoint = mountpoint;
    const oldWalArchivePath = walArchivePath;

    await operation.step('Stop container', async function stopContainer() {
      return await resources.stopAndRemoveContainer(containerName);
    }, async function rollbackContainer(removed) {
      if (!removed || originalBranch.status !== 'running') {
        return;
      }

      const id = await docker.createContainer({
        name: containerName,
        image: project.dockerImage,
        port: originalBranch.port,
        dataPath: oldMountpoint,
        walArchivePath: oldWalArchivePath,
        sslCertDir: project.sslCertDir,
        password: project.credentials.password,
        username: project.credentials.username,
        database: project.credentials.database,
        publicAccess: originalBranch.publicAccess === true,
      });

      await docker.startContainer(id);
      await docker.waitForHealthy(id);
    });

    const snapshot = await createApplicationConsistentSnapshot({
      datasetName: parentDatasetName,
      datasetPath: parentDatasetPath,
      branchStatus: parentBranch.status,
      containerName: parentContainerName,
      username: project.credentials.username,
      zfs,
      docker,
      checkpointLabel: `Checkpoint ${parentBranch.name}`,
    });

    fullSnapshotName = snapshot.fullSnapshotName;

    operation.addRollback(async function rollbackParentSnapshot() {
      await zfs.destroySnapshot(fullSnapshotName).catch(function ignoreError() {});
    });

    await replaceBranchDataset({
      operation,
      zfs,
      resources,
      fullSnapshotName,
      datasetName,
      tempDatasetName,
      backupDatasetName,
    });

    mountpoint = await zfs.getMountpoint(datasetName);

    walArchivePath = await operation.step('Prepare WAL archive', async function prepareWalArchive() {
      return await resources.recreateWalArchive(datasetName);
    });

    newContainerID = await operation.step('Start container', async function startContainer() {
      const id = await docker.createContainer({
        name: containerName,
        image: project.dockerImage,
        port: branch.port,
        dataPath: mountpoint,
        walArchivePath,
        sslCertDir: project.sslCertDir,
        password: project.credentials.password,
        username: project.credentials.username,
        database: project.credentials.database,
        publicAccess: branch.publicAccess === true,
      });

      operation.addRollback(async function rollbackNewContainer() {
        await docker.removeContainer(id);
      });

      await docker.startContainer(id);
      return id;
    });

    await operation.step('PostgreSQL ready', async function waitForPostgres() {
      await docker.waitForHealthy(newContainerID);
    });

    operation.addRollback(async function rollbackState() {
      const currentState = state.getState();
      currentState.snapshots = currentState.snapshots.filter(function keepSnapshot(snapshot) {
        return snapshot.branchName !== branch.name;
      });
      currentState.snapshots.push(...originalSnapshots);
      await state.branches.update(project.id, originalBranch);
    });

    await operation.step('Update state', async function updateState() {
      const sizeBytes = await zfs.getUsedSpace(datasetName);

      await state.snapshots.deleteForBranch(branch.name);

      branch.sizeBytes = sizeBytes;
      branch.status = 'running';
      branch.snapshotName = fullSnapshotName;
      await state.branches.update(project.id, branch);
    });
  });

  await withProgress('Clean up old dataset', async () => {
    await resources.destroyDataset(backupDatasetName).catch(function ignoreError() {});
  });

  const publicIP = await getPublicIPForBranch(branch);

  console.log();
  console.log(chalk.bold('Branch reset'));
  console.log();
  console.log(chalk.bold('Connection:'));
  console.log(formatConnectionString(
    project.credentials.username,
    project.credentials.password,
    branch.port,
    project.credentials.database,
    publicIP
  ));
  console.log();
}
