import { describe, expect, test } from 'bun:test';
import { getBranchHealth } from './branch-health-service';
import type { Branch } from '../types/state';

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

function createDependencies(overrides: {
  datasetExists?: boolean;
  containerId?: string | null;
  containerState?: 'running' | 'exited' | 'created' | 'paused';
  port?: number | null;
  walExists?: boolean;
  postgresReady?: boolean;
  sizeBytes?: number;
} = {}) {
  const datasetExists = overrides.datasetExists ?? true;
  const containerId = overrides.containerId === undefined ? 'container-1' : overrides.containerId;
  const containerState = overrides.containerState ?? 'running';
  const walExists = overrides.walExists ?? true;
  const postgresReady = overrides.postgresReady ?? true;
  const port = overrides.port === undefined ? 5432 : overrides.port;
  const sizeBytes = overrides.sizeBytes ?? 1024;

  return {
    zfs: {
      async datasetExists(): Promise<boolean> {
        return datasetExists;
      },
      async getUsedSpace(): Promise<number> {
        return sizeBytes;
      },
    },
    docker: {
      async getContainerByName(): Promise<string | null> {
        return containerId;
      },
      async getContainerStatus() {
        return {
          id: containerId || 'container-1',
          name: 'velo-api.dev',
          state: containerState,
          uptime: 1000,
          startedAt: new Date('2026-01-01T00:00:00.000Z'),
        };
      },
      async getContainerPort(): Promise<number> {
        if (port === null) {
          throw new Error('missing port');
        }

        return port;
      },
      async execSQL(): Promise<string> {
        if (!postgresReady) {
          throw new Error('not ready');
        }

        return '1';
      },
    },
    wal: {
      getArchivePath(): string {
        return '/tmp/wal/api.dev';
      },
    },
    async fileExists(): Promise<boolean> {
      return walExists;
    },
  };
}

describe('getBranchHealth', function () {
  test('reports ready branch as healthy', async function () {
    const health = await getBranchHealth(branch(), createDependencies());

    expect(health.status).toBe('healthy');
    expect(health.reason).toBe('Healthy');
    expect(health.sizeBytes).toBe(1024);
    expect(health.port).toBe(5432);
  });

  test('reports missing dataset', async function () {
    const health = await getBranchHealth(branch(), createDependencies({
      datasetExists: false,
    }));

    expect(health.status).toBe('critical');
    expect(health.reason).toBe('DatasetMissing');
    expect(health.sizeBytes).toBeNull();
  });

  test('reports missing container', async function () {
    const health = await getBranchHealth(branch(), createDependencies({
      containerId: null,
    }));

    expect(health.status).toBe('critical');
    expect(health.reason).toBe('ContainerMissing');
    expect(health.sizeBytes).toBe(1024);
  });

  test('reports exited container when state expects running', async function () {
    const health = await getBranchHealth(branch(), createDependencies({
      containerState: 'exited',
    }));

    expect(health.status).toBe('warning');
    expect(health.reason).toBe('ContainerExited');
    expect(health.observedStatus).toBe('exited');
  });

  test('reports stopped branch as healthy when container is stopped', async function () {
    const health = await getBranchHealth(branch({ status: 'stopped' }), createDependencies({
      containerState: 'exited',
    }));

    expect(health.status).toBe('healthy');
    expect(health.reason).toBe('Healthy');
    expect(health.message).toBe('Branch is stopped');
  });

  test('reports missing port', async function () {
    const health = await getBranchHealth(branch({ port: 0 }), createDependencies({
      port: null,
    }));

    expect(health.status).toBe('warning');
    expect(health.reason).toBe('PortMissing');
  });

  test('reports missing WAL archive', async function () {
    const health = await getBranchHealth(branch(), createDependencies({
      walExists: false,
    }));

    expect(health.status).toBe('warning');
    expect(health.reason).toBe('WalArchiveMissing');
  });

  test('reports state drift when state is stopped but container is running', async function () {
    const health = await getBranchHealth(branch({ status: 'stopped' }), createDependencies());

    expect(health.status).toBe('warning');
    expect(health.reason).toBe('StateDrift');
  });

  test('reports PostgreSQL readiness failure', async function () {
    const health = await getBranchHealth(branch(), createDependencies({
      postgresReady: false,
    }));

    expect(health.status).toBe('warning');
    expect(health.reason).toBe('PostgresNotReady');
  });
});
