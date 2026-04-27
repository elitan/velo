import { describe, expect, test } from 'bun:test';
import {
  applyIdleStopPolicy,
  disableIdleStopPolicy,
  enableIdleStopPolicy,
} from './idle-stop-service';
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

function createState(calls: string[]) {
  return {
    branches: {
      async update(projectId: string, item: Branch): Promise<void> {
        calls.push(`state:${projectId}:${item.name}:${item.status}:${item.idleStop?.stoppedReason || 'none'}`);
      },
    },
  };
}

function createDocker(options: {
  activeConnections?: number;
  containerId?: string | null;
  containerState?: 'running' | 'exited' | 'created' | 'paused';
  startedAt?: Date | null;
} = {}, calls: string[] = []) {
  const activeConnections = options.activeConnections ?? 0;
  const containerId = options.containerId === undefined ? 'container-1' : options.containerId;
  const containerState = options.containerState ?? 'running';
  const startedAt = options.startedAt === undefined ? new Date('2026-01-01T00:00:00.000Z') : options.startedAt;

  return {
    async getContainerByName(): Promise<string | null> {
      return containerId;
    },
    async getContainerStatus() {
      return {
        id: containerId || 'container-1',
        name: 'velo-api.dev',
        state: containerState,
        uptime: 0,
        startedAt,
      };
    },
    async execSQL(): Promise<string> {
      return activeConnections.toString();
    },
    async stopContainer(id: string): Promise<void> {
      calls.push(`stop:${id}`);
    },
  };
}

describe('idle stop policy', function () {
  test('enables policy with last active time', async function () {
    const calls: string[] = [];
    const item = branch();

    await enableIdleStopPolicy(
      item,
      'project-1',
      createState(calls),
      15,
      new Date('2026-01-01T01:00:00.000Z')
    );

    expect(item.idleStop).toEqual({
      enabled: true,
      idleMinutes: 15,
      lastActiveAt: '2026-01-01T01:00:00.000Z',
    });
    expect(calls).toEqual(['state:project-1:api/dev:running:none']);
  });

  test('disables policy without deleting last activity', async function () {
    const calls: string[] = [];
    const item = branch({
      idleStop: {
        enabled: true,
        idleMinutes: 15,
        lastActiveAt: '2026-01-01T01:00:00.000Z',
      },
    });

    await disableIdleStopPolicy(item, 'project-1', createState(calls));

    expect(item.idleStop).toEqual({
      enabled: false,
      idleMinutes: 15,
      lastActiveAt: '2026-01-01T01:00:00.000Z',
    });
  });

  test('skips disabled policy', async function () {
    const result = await applyIdleStopPolicy(
      branch(),
      'project-1',
      createState([]),
      createDocker()
    );

    expect(result.action).toBe('disabled');
  });

  test('keeps active branch running and records activity', async function () {
    const calls: string[] = [];
    const item = branch({
      idleStop: {
        enabled: true,
        idleMinutes: 15,
        lastActiveAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const result = await applyIdleStopPolicy(
      item,
      'project-1',
      createState(calls),
      createDocker({ activeConnections: 1 }, calls),
      new Date('2026-01-01T00:30:00.000Z')
    );

    expect(result.action).toBe('active');
    expect(item.status).toBe('running');
    expect(item.idleStop?.lastActiveAt).toBe('2026-01-01T00:30:00.000Z');
    expect(calls).toEqual(['state:project-1:api/dev:running:none']);
  });

  test('stops idle branch after threshold', async function () {
    const calls: string[] = [];
    const item = branch({
      idleStop: {
        enabled: true,
        idleMinutes: 15,
        lastActiveAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const result = await applyIdleStopPolicy(
      item,
      'project-1',
      createState(calls),
      createDocker({}, calls),
      new Date('2026-01-01T00:20:00.000Z')
    );

    expect(result.action).toBe('stopped');
    expect(result.idleMinutes).toBe(20);
    expect(item.status).toBe('stopped');
    expect(item.idleStop?.stoppedReason).toBe('idle-timeout');
    expect(calls).toEqual([
      'stop:container-1',
      'state:project-1:api/dev:stopped:idle-timeout',
    ]);
  });

  test('does not stop before threshold', async function () {
    const item = branch({
      idleStop: {
        enabled: true,
        idleMinutes: 15,
        lastActiveAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const result = await applyIdleStopPolicy(
      item,
      'project-1',
      createState([]),
      createDocker(),
      new Date('2026-01-01T00:05:00.000Z')
    );

    expect(result.action).toBe('idle');
    expect(item.status).toBe('running');
  });

  test('skips already stopped branch', async function () {
    const result = await applyIdleStopPolicy(
      branch({
        status: 'stopped',
        idleStop: {
          enabled: true,
          idleMinutes: 15,
        },
      }),
      'project-1',
      createState([]),
      createDocker()
    );

    expect(result.action).toBe('already-stopped');
  });
});
