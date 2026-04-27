import type { Branch } from '../types/state';
import type { ContainerStatus, DockerManager } from '../managers/docker';
import type { ZFSManager } from '../managers/zfs';
import type { WALManager } from '../managers/wal';
import { getBranchContainerName } from '../utils/naming';
import * as fs from 'fs/promises';

export type BranchHealthReason =
  | 'Healthy'
  | 'DatasetMissing'
  | 'ContainerMissing'
  | 'ContainerExited'
  | 'PostgresNotReady'
  | 'PortMissing'
  | 'WalArchiveMissing'
  | 'StateDrift';

type HealthStatus = 'healthy' | 'warning' | 'critical';

type HealthZfs = Pick<ZFSManager, 'datasetExists' | 'getUsedSpace'>;
type HealthDocker = Pick<DockerManager, 'getContainerByName' | 'getContainerStatus' | 'getContainerPort' | 'execSQL'>;
type HealthWal = Pick<WALManager, 'getArchivePath'>;

export interface BranchHealthDependencies {
  zfs: HealthZfs;
  docker: HealthDocker;
  wal: HealthWal;
  fileExists?: (path: string) => Promise<boolean>;
}

export interface BranchHealth {
  status: HealthStatus;
  reason: BranchHealthReason;
  message: string;
  hint?: string;
  containerName: string;
  containerId: string | null;
  observedStatus: ContainerStatus['state'] | 'missing';
  startedAt: Date | null;
  port: number | null;
  sizeBytes: number | null;
}

export async function getBranchHealth(
  branch: Branch,
  dependencies: BranchHealthDependencies
): Promise<BranchHealth> {
  const containerName = getBranchContainerName(branch);
  const base = {
    containerName,
    containerId: null,
    observedStatus: 'missing' as const,
    startedAt: null,
    port: null,
    sizeBytes: null,
  };

  if (!(await dependencies.zfs.datasetExists(branch.zfsDataset))) {
    return unhealthy({
      ...base,
      reason: 'DatasetMissing',
      message: `Dataset '${branch.zfsDataset}' was not found`,
      hint: 'Run velo cleanup, restore from backup, or recreate the branch',
      status: 'critical',
    });
  }

  const sizeBytes = await getDatasetSize(branch, dependencies.zfs);
  const containerId = await dependencies.docker.getContainerByName(containerName);

  if (!containerId) {
    return unhealthy({
      ...base,
      sizeBytes,
      reason: 'ContainerMissing',
      message: `Container '${containerName}' was not found`,
      hint: branch.status === 'stopped' ? 'Run velo branch start' : 'Run velo branch restart or recreate the branch',
      status: 'critical',
    });
  }

  const containerStatus = await dependencies.docker.getContainerStatus(containerId);
  const observed = {
    containerName,
    containerId,
    observedStatus: containerStatus.state,
    startedAt: containerStatus.startedAt,
    sizeBytes,
  };

  if (containerStatus.state !== 'running') {
    if (branch.status === 'stopped') {
      return healthy({
        ...observed,
        port: branch.port || null,
        message: 'Branch is stopped',
      });
    }

    return unhealthy({
      ...observed,
      port: branch.port || null,
      reason: 'ContainerExited',
      message: `Container is ${containerStatus.state}`,
      hint: 'Run velo branch start or inspect docker logs',
      status: 'warning',
    });
  }

  if (branch.status !== 'running') {
    return unhealthy({
      ...observed,
      port: branch.port || null,
      reason: 'StateDrift',
      message: `State says '${branch.status}' but container is running`,
      hint: 'Run velo branch restart to refresh state',
      status: 'warning',
    });
  }

  const port = await getObservedPort(containerId, dependencies.docker);
  if (!port || branch.port <= 0) {
    return unhealthy({
      ...observed,
      port,
      reason: 'PortMissing',
      message: 'Container has no published PostgreSQL port',
      hint: 'Run velo branch restart to recreate the port binding',
      status: 'warning',
    });
  }

  const walArchivePath = dependencies.wal.getArchivePath(branch.zfsDataset);
  const fileExists = dependencies.fileExists || defaultFileExists;
  if (!(await fileExists(walArchivePath))) {
    return unhealthy({
      ...observed,
      port,
      reason: 'WalArchiveMissing',
      message: `WAL archive '${walArchivePath}' was not found`,
      hint: 'Run velo branch restart or recreate WAL archive state',
      status: 'warning',
    });
  }

  try {
    await dependencies.docker.execSQL(containerId, 'SELECT 1');
  } catch {
    return unhealthy({
      ...observed,
      port,
      reason: 'PostgresNotReady',
      message: 'PostgreSQL is not accepting connections',
      hint: 'Wait and retry, or inspect docker logs',
      status: 'warning',
    });
  }

  return healthy({
    ...observed,
    port,
    message: 'Branch is ready',
  });
}

function healthy(options: Omit<BranchHealth, 'reason' | 'status' | 'hint'> & { message: string }): BranchHealth {
  return {
    ...options,
    status: 'healthy',
    reason: 'Healthy',
  };
}

function unhealthy(options: BranchHealth): BranchHealth {
  return options;
}

async function getObservedPort(containerId: string, docker: HealthDocker): Promise<number | null> {
  try {
    return await docker.getContainerPort(containerId);
  } catch {
    return null;
  }
}

async function getDatasetSize(branch: Branch, zfs: HealthZfs): Promise<number | null> {
  try {
    return await zfs.getUsedSpace(branch.zfsDataset);
  } catch {
    return null;
  }
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
