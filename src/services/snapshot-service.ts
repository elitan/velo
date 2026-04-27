import { ZFSManager } from '../managers/zfs';
import { DockerManager } from '../managers/docker';
import { formatTimestamp, generateUUID } from '../utils/helpers';
import { withProgress } from '../utils/progress';
import { UserError } from '../errors';
import { getBranchContainerName, getDatasetPathFromName } from '../utils/naming';
import type { Branch, Project, Snapshot, State } from '../types/state';

interface SnapshotState {
  snapshots: {
    add(snapshot: Snapshot): Promise<void>;
  };
}

export interface CreateSnapshotParams {
  datasetName: string;
  datasetPath: string;
  branchStatus: 'created' | 'running' | 'stopped';
  containerName: string;
  username: string;
  label?: string;
  zfs: ZFSManager;
  docker: DockerManager;
  /** Custom label for checkpoint progress (default: "Checkpoint") */
  checkpointLabel?: string;
  /** Custom label for snapshot progress (default: "Create snapshot") */
  snapshotLabel?: string;
}

export interface CreateSnapshotResult {
  snapshotName: string;
  fullSnapshotName: string;
}

export interface CreateBranchSnapshotParams {
  state: SnapshotState;
  stateData: State;
  branch: Branch;
  project: Project;
  label?: string;
  createdAt?: Date;
  zfs: ZFSManager;
  docker: DockerManager;
}

export interface CreateBranchSnapshotResult {
  snapshot: Snapshot;
  snapshotName: string;
}

/**
 * Creates an application-consistent ZFS snapshot of a PostgreSQL database.
 *
 * If the database is running, executes CHECKPOINT before snapshot to ensure
 * all data is flushed to disk. This provides zero data loss - all committed
 * transactions are included in the snapshot.
 */
export async function createApplicationConsistentSnapshot(
  params: CreateSnapshotParams
): Promise<CreateSnapshotResult> {
  const {
    datasetName,
    datasetPath,
    branchStatus,
    containerName,
    username,
    label,
    zfs,
    docker,
    checkpointLabel = 'Checkpoint',
    snapshotLabel = 'Create snapshot',
  } = params;

  // Execute CHECKPOINT if database is running
  if (branchStatus === 'running') {
    const containerID = await docker.getContainerByName(containerName);
    if (!containerID) {
      throw new UserError(`Container ${containerName} not found`);
    }

    await withProgress(checkpointLabel, async () => {
      await docker.execSQL(containerID, 'CHECKPOINT;', username);
    });
  }

  // Generate snapshot name
  const timestamp = formatTimestamp(new Date());
  const snapshotName = label ? `${timestamp}-${label}` : timestamp;
  const fullSnapshotName = `${datasetPath}@${snapshotName}`;

  // Create ZFS snapshot immediately after checkpoint
  await withProgress(snapshotLabel, async () => {
    await zfs.createSnapshot(datasetName, snapshotName);
  });

  return { snapshotName, fullSnapshotName };
}

export async function createBranchSnapshot(
  params: CreateBranchSnapshotParams
): Promise<CreateBranchSnapshotResult> {
  const {
    state,
    stateData,
    branch,
    project,
    label,
    createdAt = new Date(),
    zfs,
    docker,
  } = params;
  const containerName = getBranchContainerName(branch);
  const datasetName = branch.zfsDataset;
  const datasetPath = getDatasetPathFromName(stateData.zfsPool, stateData.zfsDatasetBase, datasetName);
  const { snapshotName, fullSnapshotName } = await createApplicationConsistentSnapshot({
    datasetName,
    datasetPath,
    branchStatus: branch.status,
    containerName,
    username: project.credentials.username,
    label,
    zfs,
    docker,
  });

  const sizeBytes = await withProgress('Calculate size', async function () {
    return await zfs.getSnapshotSize(fullSnapshotName);
  });

  const snapshot: Snapshot = {
    id: generateUUID(),
    branchId: branch.id,
    branchName: branch.name,
    projectName: project.name,
    zfsSnapshot: fullSnapshotName,
    createdAt: createdAt.toISOString(),
    label,
    sizeBytes,
  };

  await state.snapshots.add(snapshot);

  return { snapshot, snapshotName };
}
