import { describe, expect, test } from 'bun:test';
import { createBranchSnapshot } from './snapshot-service';
import type { Branch, Project, Snapshot, State } from '../types/state';

function branch(): Branch {
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
    status: 'stopped',
  };
}

function project(): Project {
  return {
    id: 'project-1',
    name: 'api',
    dockerImage: 'postgres:17-alpine',
    sslCertDir: '/tmp/certs',
    createdAt: '2026-01-01T00:00:00.000Z',
    credentials: {
      username: 'postgres',
      password: 'secret',
      database: 'postgres',
    },
    branches: [],
  };
}

function stateData(): State {
  return {
    schemaVersion: 4,
    version: '1.0.0',
    initializedAt: '2026-01-01T00:00:00.000Z',
    zfsPool: 'tank',
    zfsDatasetBase: 'velo/databases',
    projects: [],
    snapshots: [],
  };
}

describe('createBranchSnapshot', function () {
  test('creates zfs snapshot and stores snapshot record', async function () {
    const calls: string[] = [];
    let storedSnapshot: Snapshot | undefined;
    const state = {
      snapshots: {
        async add(snapshot: Snapshot): Promise<void> {
          storedSnapshot = snapshot;
          calls.push(`state:${snapshot.branchName}:${snapshot.label}`);
        },
      },
    };
    const zfs = {
      async createSnapshot(datasetName: string, snapshotName: string): Promise<void> {
        calls.push(`zfs:${datasetName}:${snapshotName.endsWith('-scheduled-hourly')}`);
      },
      async getSnapshotSize(snapshotName: string): Promise<number> {
        calls.push(`size:${snapshotName.includes('@')}`);
        return 42;
      },
    };

    const result = await createBranchSnapshot({
      state,
      stateData: stateData(),
      branch: branch(),
      project: project(),
      label: 'scheduled-hourly',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      zfs: zfs as any,
      docker: {} as any,
    });

    expect(result.snapshotName.endsWith('-scheduled-hourly')).toBe(true);
    expect(storedSnapshot?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(storedSnapshot?.projectName).toBe('api');
    expect(storedSnapshot?.sizeBytes).toBe(42);
    expect(calls).toEqual([
      'zfs:api.dev:true',
      'size:true',
      'state:api/dev:scheduled-hourly',
    ]);
  });
});
