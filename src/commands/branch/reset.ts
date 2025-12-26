import chalk from 'chalk';
import { createApplicationConsistentSnapshot } from '../../services/snapshot-service';
import { PATHS } from '../../utils/paths';
import { parseNamespace } from '../../utils/namespace';
import { getContainerName, getDatasetName, getDatasetPath } from '../../utils/naming';
import { UserError } from '../../errors';
import { withProgress } from '../../utils/progress';
import { getPublicIP, formatConnectionString } from '../../utils/network';
import { CLI_NAME } from '../../config/constants';
import { initializeServices, getBranchWithProject } from '../../utils/service-factory';

export async function branchResetCommand(name: string, options: { force?: boolean } = {}) {
  const namespace = parseNamespace(name);

  const { state, docker, zfs, stateData } = await initializeServices();
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
  const parentNamespace = parseNamespace(parentBranch.name);
  const parentContainerName = getContainerName(parentNamespace.project, parentNamespace.branch);
  const parentDatasetName = getDatasetName(parentNamespace.project, parentNamespace.branch);
  const parentDatasetPath = getDatasetPath(stateData.zfsPool, stateData.zfsDatasetBase, parentNamespace.project, parentNamespace.branch);

  // Compute current branch names
  const containerName = getContainerName(namespace.project, namespace.branch);
  const datasetName = getDatasetName(namespace.project, namespace.branch);

  // If force reset, clean up dependent branches first
  if (dependentBranches.length > 0 && options.force) {
    await withProgress('Clean up dependent branches', async () => {
      for (const depBranch of dependentBranches) {
        const depNamespace = parseNamespace(depBranch.name);
        const depContainerName = getContainerName(depNamespace.project, depNamespace.branch);

        // Stop and remove container
        const depContainerID = await docker.getContainerByName(depContainerName);
        if (depContainerID) {
          await docker.stopContainer(depContainerID);
          await docker.removeContainer(depContainerID);
        }

        // Clean up snapshots from state
        await state.snapshots.deleteForBranch(depBranch.name);

        // Remove branch from state (will be destroyed with ZFS dataset)
        await state.branches.delete(project.id, depBranch.id);
      }
    });
  }

  // Stop and remove existing container
  await withProgress('Stop container', async () => {
    const containerID = await docker.getContainerByName(containerName);
    if (containerID) {
      await docker.stopContainer(containerID);
      await docker.removeContainer(containerID);
    }
  });

  // Create application-consistent snapshot of parent
  const { fullSnapshotName } = await createApplicationConsistentSnapshot({
    datasetName: parentDatasetName,
    datasetPath: parentDatasetPath,
    branchStatus: parentBranch.status,
    containerName: parentContainerName,
    username: project.credentials.username,
    zfs,
    docker,
    checkpointLabel: `Checkpoint ${parentBranch.name}`,
  });

  // Safe clone-then-swap: clone to temp first, then swap
  // This prevents data loss if cloning fails
  const tempDatasetName = `${datasetName}-temp`;
  const backupDatasetName = `${datasetName}-old`;

  // Step 1: Clone to temporary dataset
  await withProgress('Clone new snapshot', async () => {
    await zfs.cloneSnapshot(fullSnapshotName, tempDatasetName);
  });

  // Step 2: Mount temp dataset to verify it works
  await withProgress('Mount temp dataset', async () => {
    await zfs.mountDataset(tempDatasetName);
  });

  // Step 3: Swap datasets (original is still intact until this succeeds)
  await withProgress('Swap datasets', async () => {
    // Unmount original
    await zfs.unmountDataset(datasetName);

    // Rename original to backup
    await zfs.renameDataset(datasetName, backupDatasetName);

    // Unmount temp before rename (required by ZFS)
    await zfs.unmountDataset(tempDatasetName);

    // Rename temp to original name
    await zfs.renameDataset(tempDatasetName, datasetName);
  });

  // Step 4: Mount the swapped dataset
  await withProgress('Mount dataset', async () => {
    await zfs.mountDataset(datasetName);
  });

  // Step 5: Clean up backup (best effort - don't fail if this errors)
  await withProgress('Clean up old dataset', async () => {
    await zfs.destroyDataset(backupDatasetName, true).catch(() => {});
  });

  const mountpoint = await zfs.getMountpoint(datasetName);

  // Create WAL archive directory
  const walArchivePath = `${PATHS.WAL_ARCHIVE}/${datasetName}`;
  await Bun.write(walArchivePath + '/.keep', '');

  // Recreate container with same port (use project's docker image)
  const newContainerID = await withProgress('Start container', async () => {
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
    });

    await docker.startContainer(id);
    return id;
  });

  await withProgress('PostgreSQL ready', async () => {
    await docker.waitForHealthy(newContainerID);
  });

  // Clean up orphaned snapshots for this branch (ZFS snapshots were destroyed with dataset)
  await state.snapshots.deleteForBranch(branch.name);

  // Update state
  const sizeBytes = await zfs.getUsedSpace(datasetName);
  branch.sizeBytes = sizeBytes;
  branch.status = 'running';
  branch.snapshotName = fullSnapshotName;
  await state.branches.update(project.id, branch);

  // Get public IP for remote connection info
  const publicIP = await getPublicIP();

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
