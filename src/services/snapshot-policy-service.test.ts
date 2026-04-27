import { describe, expect, test } from 'bun:test';
import {
  disableSnapshotPolicy,
  enableSnapshotPolicy,
  formatSnapshotScheduleDryRun,
  getExpiredSnapshots,
  getSnapshotSchedulePlan,
  recordSnapshotPolicySuccess,
} from './snapshot-policy-service';
import type { Branch, Snapshot } from '../types/state';

function branch(overrides: Partial<Branch> = {}): Branch {
  return {
    id: 'branch-1',
    name: 'api/dev',
    projectName: 'api',
    parentBranchId: 'main',
    isPrimary: false,
    snapshotName: null,
    zfsDataset: 'api.dev',
    containerName: 'velo-api.dev',
    port: 5432,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
    ...overrides,
  };
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 'snapshot-1',
    branchId: 'branch-1',
    branchName: 'api/dev',
    projectName: 'api',
    zfsSnapshot: 'tank/velo/api.dev@snapshot-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createState(calls: string[]) {
  return {
    branches: {
      async update(projectId: string, item: Branch): Promise<void> {
        calls.push(`state:${projectId}:${item.name}:${item.snapshotPolicy?.enabled ? 'enabled' : 'disabled'}`);
      },
    },
  };
}

describe('snapshot policy', function () {
  test('enables hourly schedule with retention settings', async function () {
    const calls: string[] = [];
    const item = branch();

    await enableSnapshotPolicy(
      item,
      'project-1',
      createState(calls),
      {
        interval: 'hourly',
        retentionDays: 14,
        walRetentionDays: 3,
      },
      new Date('2026-01-01T00:00:00.000Z')
    );

    expect(item.snapshotPolicy).toEqual({
      enabled: true,
      interval: 'hourly',
      retentionDays: 14,
      walRetentionDays: 3,
      lastRunAt: undefined,
      nextRunAt: '2026-01-01T01:00:00.000Z',
    });
    expect(calls).toEqual(['state:project-1:api/dev:enabled']);
  });

  test('disables policy without deleting timing state', async function () {
    const calls: string[] = [];
    const item = branch({
      snapshotPolicy: {
        enabled: true,
        interval: 'daily',
        retentionDays: 30,
        walRetentionDays: 7,
        lastRunAt: '2026-01-01T00:00:00.000Z',
        nextRunAt: '2026-01-02T00:00:00.000Z',
      },
    });

    await disableSnapshotPolicy(item, 'project-1', createState(calls));

    expect(item.snapshotPolicy?.enabled).toBe(false);
    expect(item.snapshotPolicy?.lastRunAt).toBe('2026-01-01T00:00:00.000Z');
    expect(item.snapshotPolicy?.nextRunAt).toBe('2026-01-02T00:00:00.000Z');
  });

  test('marks schedule due and reports cleanup cutoffs', function () {
    const plan = getSnapshotSchedulePlan(
      branch({
        snapshotPolicy: {
          enabled: true,
          interval: 'daily',
          retentionDays: 30,
          walRetentionDays: 7,
          nextRunAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      new Date('2026-01-02T00:00:00.000Z')
    );

    expect(plan.action).toBe('due');
    expect(plan.snapshotCutoffAt).toBe('2025-12-03T00:00:00.000Z');
    expect(plan.walCutoffAt).toBe('2025-12-26T00:00:00.000Z');
  });

  test('selects expired snapshots for one branch', function () {
    const expired = getExpiredSnapshots(
      [
        snapshot({ id: 'old-dev', createdAt: '2026-01-01T00:00:00.000Z' }),
        snapshot({ id: 'new-dev', createdAt: '2026-01-10T00:00:00.000Z' }),
        snapshot({ id: 'old-main', branchName: 'api/main', createdAt: '2026-01-01T00:00:00.000Z' }),
      ],
      'api/dev',
      7,
      new Date('2026-01-10T00:00:01.000Z')
    );

    expect(expired.map(function (item) {
      return item.id;
    })).toEqual(['old-dev']);
  });

  test('records success with next run and clears failure', async function () {
    const item = branch({
      snapshotPolicy: {
        enabled: true,
        interval: 'daily',
        retentionDays: 30,
        walRetentionDays: 7,
        lastFailure: 'disk full',
      },
    });

    await recordSnapshotPolicySuccess(
      item,
      'project-1',
      createState([]),
      new Date('2026-01-01T00:00:00.000Z')
    );

    expect(item.snapshotPolicy?.lastRunAt).toBe('2026-01-01T00:00:00.000Z');
    expect(item.snapshotPolicy?.nextRunAt).toBe('2026-01-02T00:00:00.000Z');
    expect(item.snapshotPolicy?.lastFailure).toBeUndefined();
  });

  test('formats dry-run output with planned cleanup', function () {
    const plan = getSnapshotSchedulePlan(
      branch({
        snapshotPolicy: {
          enabled: true,
          interval: 'hourly',
          retentionDays: 14,
          walRetentionDays: 3,
        },
      }),
      new Date('2026-01-10T00:00:00.000Z')
    );

    expect(formatSnapshotScheduleDryRun(plan, 2)).toBe(
      'would create snapshot, delete 2 snapshot(s), clean WAL older than 2026-01-07T00:00:00.000Z'
    );
  });
});
