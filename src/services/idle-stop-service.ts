import type { Branch } from '../types/state';
import type { DockerManager } from '../managers/docker';
import { getBranchContainerName } from '../utils/naming';

type IdleStopDocker = Pick<DockerManager, 'getContainerByName' | 'getContainerStatus' | 'execSQL' | 'stopContainer'>;

interface IdleStopState {
  branches: {
    update(projectId: string, branch: Branch): Promise<void>;
  };
}

export type IdleStopAction =
  | 'disabled'
  | 'already-stopped'
  | 'container-missing'
  | 'active'
  | 'idle'
  | 'stopped';

export interface IdleStopResult {
  branchName: string;
  action: IdleStopAction;
  message: string;
  idleMinutes?: number;
  activeConnections?: number;
  lastActiveAt?: string;
  containerId?: string;
}

export async function enableIdleStopPolicy(
  branch: Branch,
  projectId: string,
  state: IdleStopState,
  idleMinutes: number,
  now = new Date()
): Promise<void> {
  branch.idleStop = {
    enabled: true,
    idleMinutes,
    lastActiveAt: branch.idleStop?.lastActiveAt || now.toISOString(),
  };

  await state.branches.update(projectId, branch);
}

export async function disableIdleStopPolicy(
  branch: Branch,
  projectId: string,
  state: IdleStopState
): Promise<void> {
  branch.idleStop = {
    enabled: false,
    idleMinutes: branch.idleStop?.idleMinutes || 0,
    lastActiveAt: branch.idleStop?.lastActiveAt,
  };

  await state.branches.update(projectId, branch);
}

export async function applyIdleStopPolicy(
  branch: Branch,
  projectId: string,
  state: IdleStopState,
  docker: IdleStopDocker,
  now = new Date()
): Promise<IdleStopResult> {
  const result = await evaluateIdleStopPolicy(branch, docker, now);
  const policy = branch.idleStop;

  if (!policy?.enabled) {
    return result;
  }

  if (result.action === 'active') {
    branch.idleStop = {
      ...policy,
      lastActiveAt: now.toISOString(),
      stoppedReason: undefined,
    };
    await state.branches.update(projectId, branch);

    return {
      ...result,
      lastActiveAt: branch.idleStop.lastActiveAt,
    };
  }

  if (result.action !== 'stopped') {
    return result;
  }

  await docker.stopContainer(result.containerId!);
  branch.status = 'stopped';
  branch.idleStop = {
    ...policy,
    lastActiveAt: result.lastActiveAt,
    stoppedReason: 'idle-timeout',
  };
  await state.branches.update(projectId, branch);

  return result;
}

export async function evaluateIdleStopPolicy(
  branch: Branch,
  docker: IdleStopDocker,
  now = new Date()
): Promise<IdleStopResult> {
  const policy = branch.idleStop;

  if (!policy?.enabled) {
    return {
      branchName: branch.name,
      action: 'disabled',
      message: 'Idle stop disabled',
    };
  }

  if (branch.status !== 'running') {
    return {
      branchName: branch.name,
      action: 'already-stopped',
      message: 'Branch is not running',
    };
  }

  const containerId = await docker.getContainerByName(getBranchContainerName(branch));
  if (!containerId) {
    return {
      branchName: branch.name,
      action: 'container-missing',
      message: 'Container missing',
    };
  }

  const containerStatus = await docker.getContainerStatus(containerId);
  if (containerStatus.state !== 'running') {
    return {
      branchName: branch.name,
      action: 'already-stopped',
      message: `Container is ${containerStatus.state}`,
    };
  }

  const activeConnections = await getActiveConnectionCount(docker, containerId);
  if (activeConnections > 0) {
    return {
      branchName: branch.name,
      action: 'active',
      activeConnections,
      lastActiveAt: now.toISOString(),
      message: `${activeConnections} active connection(s)`,
    };
  }

  const lastActiveAt = policy.lastActiveAt || containerStatus.startedAt?.toISOString() || branch.createdAt;
  const idleMinutes = Math.floor((now.getTime() - new Date(lastActiveAt).getTime()) / 60000);

  if (idleMinutes < policy.idleMinutes) {
    return {
      branchName: branch.name,
      action: 'idle',
      idleMinutes,
      lastActiveAt,
      message: `Idle for ${idleMinutes} minute(s)`,
    };
  }

  return {
    branchName: branch.name,
    action: 'stopped',
    containerId,
    idleMinutes,
    lastActiveAt,
    message: `Stopped after ${idleMinutes} idle minute(s)`,
  };
}

async function getActiveConnectionCount(docker: IdleStopDocker, containerId: string): Promise<number> {
  const output = await docker.execSQL(
    containerId,
    "SELECT COUNT(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database();"
  );
  const count = Number.parseInt(output.trim(), 10);

  if (Number.isNaN(count)) {
    return 0;
  }

  return count;
}
