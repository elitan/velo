import type {
  Branch,
  Snapshot,
  SnapshotPolicy,
  SnapshotScheduleInterval,
} from '../types/state';

const DAY_MS = 24 * 60 * 60 * 1000;

interface SnapshotPolicyState {
  branches: {
    update(projectId: string, branch: Branch): Promise<void>;
  };
}

export type SnapshotScheduleAction = 'disabled' | 'due' | 'not-due';

export interface EnableSnapshotPolicyOptions {
  interval: SnapshotScheduleInterval;
  retentionDays: number;
  walRetentionDays: number;
}

export interface SnapshotSchedulePlan {
  branchName: string;
  action: SnapshotScheduleAction;
  message: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastFailure?: string;
  snapshotRetentionDays?: number;
  walRetentionDays?: number;
  snapshotCutoffAt?: string;
  walCutoffAt?: string;
}

export async function enableSnapshotPolicy(
  branch: Branch,
  projectId: string,
  state: SnapshotPolicyState,
  options: EnableSnapshotPolicyOptions,
  now = new Date()
): Promise<void> {
  branch.snapshotPolicy = {
    enabled: true,
    interval: options.interval,
    retentionDays: options.retentionDays,
    walRetentionDays: options.walRetentionDays,
    lastRunAt: branch.snapshotPolicy?.lastRunAt,
    nextRunAt: getNextSnapshotRunAt(options.interval, now).toISOString(),
  };

  await state.branches.update(projectId, branch);
}

export async function disableSnapshotPolicy(
  branch: Branch,
  projectId: string,
  state: SnapshotPolicyState
): Promise<void> {
  branch.snapshotPolicy = {
    enabled: false,
    interval: branch.snapshotPolicy?.interval || 'daily',
    retentionDays: branch.snapshotPolicy?.retentionDays || 30,
    walRetentionDays: branch.snapshotPolicy?.walRetentionDays || 7,
    lastRunAt: branch.snapshotPolicy?.lastRunAt,
    nextRunAt: branch.snapshotPolicy?.nextRunAt,
    lastFailure: branch.snapshotPolicy?.lastFailure,
  };

  await state.branches.update(projectId, branch);
}

export async function recordSnapshotPolicySuccess(
  branch: Branch,
  projectId: string,
  state: SnapshotPolicyState,
  now = new Date()
): Promise<void> {
  const policy = getRequiredSnapshotPolicy(branch);

  branch.snapshotPolicy = {
    ...policy,
    lastRunAt: now.toISOString(),
    nextRunAt: getNextSnapshotRunAt(policy.interval, now).toISOString(),
    lastFailure: undefined,
  };

  await state.branches.update(projectId, branch);
}

export async function recordSnapshotPolicyFailure(
  branch: Branch,
  projectId: string,
  state: SnapshotPolicyState,
  message: string,
  now = new Date()
): Promise<void> {
  const policy = getRequiredSnapshotPolicy(branch);

  branch.snapshotPolicy = {
    ...policy,
    nextRunAt: now.toISOString(),
    lastFailure: message,
  };

  await state.branches.update(projectId, branch);
}

export function getSnapshotSchedulePlan(branch: Branch, now = new Date()): SnapshotSchedulePlan {
  const policy = branch.snapshotPolicy;

  if (!policy?.enabled) {
    return {
      branchName: branch.name,
      action: 'disabled',
      message: 'Snapshot schedule disabled',
    };
  }

  const nextRunAt = getEffectiveNextRunAt(policy, now);
  const base = {
    branchName: branch.name,
    nextRunAt: nextRunAt.toISOString(),
    lastRunAt: policy.lastRunAt,
    lastFailure: policy.lastFailure,
    snapshotRetentionDays: policy.retentionDays,
    walRetentionDays: policy.walRetentionDays,
    snapshotCutoffAt: getCutoffAt(policy.retentionDays, now).toISOString(),
    walCutoffAt: getCutoffAt(policy.walRetentionDays, now).toISOString(),
  };

  if (now.getTime() >= nextRunAt.getTime()) {
    return {
      ...base,
      action: 'due',
      message: 'Snapshot schedule is due',
    };
  }

  return {
    ...base,
    action: 'not-due',
    message: `Next snapshot at ${nextRunAt.toISOString()}`,
  };
}

export function getExpiredSnapshots(
  snapshots: Snapshot[],
  branchName: string,
  retentionDays: number,
  now = new Date()
): Snapshot[] {
  const cutoff = getCutoffAt(retentionDays, now);

  return snapshots.filter(function (snapshot) {
    return snapshot.branchName === branchName && new Date(snapshot.createdAt).getTime() < cutoff.getTime();
  });
}

export function formatSnapshotScheduleDryRun(plan: SnapshotSchedulePlan, expiredSnapshotCount: number): string {
  if (plan.action === 'disabled') {
    return 'disabled';
  }

  if (plan.action === 'not-due') {
    return `not due until ${plan.nextRunAt}`;
  }

  return `would create snapshot, delete ${expiredSnapshotCount} snapshot(s), clean WAL older than ${plan.walCutoffAt}`;
}

export function getNextSnapshotRunAt(interval: SnapshotScheduleInterval, from: Date): Date {
  if (interval === 'hourly') {
    return new Date(from.getTime() + 60 * 60 * 1000);
  }

  return new Date(from.getTime() + DAY_MS);
}

function getEffectiveNextRunAt(policy: SnapshotPolicy, now: Date): Date {
  if (policy.nextRunAt) {
    const nextRunAt = new Date(policy.nextRunAt);
    if (!Number.isNaN(nextRunAt.getTime())) {
      return nextRunAt;
    }
  }

  if (policy.lastRunAt) {
    const lastRunAt = new Date(policy.lastRunAt);
    if (!Number.isNaN(lastRunAt.getTime())) {
      return getNextSnapshotRunAt(policy.interval, lastRunAt);
    }
  }

  return now;
}

function getCutoffAt(retentionDays: number, now: Date): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

function getRequiredSnapshotPolicy(branch: Branch): SnapshotPolicy {
  if (!branch.snapshotPolicy) {
    throw new Error(`Snapshot policy missing for ${branch.name}`);
  }

  return branch.snapshotPolicy;
}
