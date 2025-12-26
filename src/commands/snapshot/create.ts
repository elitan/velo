import chalk from 'chalk';
import { StateManager } from '../../managers/state';
import { ZFSManager } from '../../managers/zfs';
import { DockerManager } from '../../managers/docker';
import { PATHS } from '../../utils/paths';
import { parseNamespace } from '../../utils/namespace';
import { generateUUID } from '../../utils/helpers';
import type { Snapshot } from '../../types/state';
import { UserError } from '../../errors';
import { withProgress } from '../../utils/progress';
import { getContainerName, getDatasetName, getDatasetPath } from '../../utils/naming';
import { CLI_NAME } from '../../config/constants';
import { createApplicationConsistentSnapshot } from '../../services/snapshot-service';

export interface SnapshotCreateOptions {
  label?: string;
}

export async function snapshotCreateCommand(branchName: string, options: SnapshotCreateOptions = {}) {
  const target = parseNamespace(branchName);

  console.log();
  if (options.label) {
    console.log(`Creating snapshot of ${chalk.bold(target.full)} (${chalk.dim(options.label)})...`);
  } else {
    console.log(`Creating snapshot of ${chalk.bold(target.full)}...`);
  }
  console.log();

  const state = new StateManager(PATHS.STATE);
  await state.load();

  // Find the branch
  const proj = state.projects.getByName(target.project);
  if (!proj) {
    throw new UserError(
      `Project '${target.project}' not found`,
      `Run '${CLI_NAME} project list' to see available projects`
    );
  }

  const branch = proj.branches.find(b => b.name === target.full);
  if (!branch) {
    throw new UserError(
      `Branch '${target.full}' not found`,
      `Run '${CLI_NAME} branch list' to see available branches`
    );
  }

  // Get ZFS config from state
  const stateData = state.getState();
  const zfs = new ZFSManager(stateData.zfsPool, stateData.zfsDatasetBase);

  // Compute names
  const containerName = getContainerName(target.project, target.branch);
  const datasetName = getDatasetName(target.project, target.branch);
  const datasetPath = getDatasetPath(stateData.zfsPool, stateData.zfsDatasetBase, target.project, target.branch);

  // Create application-consistent snapshot
  const docker = new DockerManager();
  const { snapshotName, fullSnapshotName } = await createApplicationConsistentSnapshot({
    datasetName,
    datasetPath,
    branchStatus: branch.status,
    containerName,
    username: proj.credentials.username,
    label: options.label,
    zfs,
    docker,
  });

  // Get snapshot size
  const sizeBytes = await withProgress('Calculate size', async () => {
    return await zfs.getSnapshotSize(fullSnapshotName);
  });

  // Create snapshot record
  const snapshot: Snapshot = {
    id: generateUUID(),
    branchId: branch.id,
    branchName: branch.name,
    projectName: target.project,
    zfsSnapshot: fullSnapshotName,
    createdAt: new Date().toISOString(),
    label: options.label,
    sizeBytes,
  };

  await state.snapshots.add(snapshot);

  console.log();
  console.log(chalk.bold('Snapshot created'));
  console.log();
  console.log(`  ID: ${snapshot.id}`);
  console.log(`  Name: ${snapshotName}`);
  console.log();
}
