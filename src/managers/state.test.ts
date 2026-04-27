import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import { StateManager } from './state';
import type { Branch, Project } from '../types/state';

describe('StateManager operation lock', function () {
  const testDir = '/tmp/velo-operation-lock-test';
  const stateFile = path.join(testDir, 'state.json');
  const operationLockFile = `${stateFile}.operation.lock`;

  beforeEach(async function () {
    await fs.rm(testDir, { recursive: true, force: true });
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async function () {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('serializes long operations across managers', async function () {
    const first = new StateManager(stateFile);
    const second = new StateManager(stateFile);
    const events: string[] = [];
    let releaseFirst!: () => void;

    const firstDone = first.withOperationLock(async function runFirstOperation() {
      events.push('first:start');
      await new Promise<void>(function waitForRelease(resolve) {
        releaseFirst = resolve;
      });
      events.push('first:end');
    });

    await waitForEvent(events, 'first:start');

    const secondDone = second.withOperationLock(async function runSecondOperation() {
      events.push('second:start');
    });

    await Bun.sleep(150);
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await firstDone;
    await secondDone;

    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  test('removes stale operation locks from dead processes', async function () {
    const state = new StateManager(stateFile);
    await fs.writeFile(operationLockFile, '999999999');

    await state.withOperationLock(async function runOperation() {
      expect(await Bun.file(operationLockFile).exists()).toBe(true);
    });

    expect(await Bun.file(operationLockFile).exists()).toBe(false);
  });

  test('creates the lock directory before first state write', async function () {
    await fs.rm(testDir, { recursive: true, force: true });

    const state = new StateManager(stateFile);
    await state.withOperationLock(async function runOperation() {
      expect(await Bun.file(operationLockFile).exists()).toBe(true);
    });

    expect(await Bun.file(operationLockFile).exists()).toBe(false);
  });

  test('prevents duplicate concurrent branch creation', async function () {
    const setup = new StateManager(stateFile);
    await setup.initialize('tank', 'velo/databases');
    await setup.projects.add(createProject());

    const first = createBranchLikeService(new StateManager(stateFile), 'branch-2');
    const second = createBranchLikeService(new StateManager(stateFile), 'branch-3');

    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter(function isFulfilled(result) {
      return result.status === 'fulfilled';
    });
    const rejected = results.filter(function isRejected(result) {
      return result.status === 'rejected';
    });

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const state = new StateManager(stateFile);
    await state.load();

    const project = state.projects.getByName('api');
    const branches = project?.branches.filter(function filterDevBranch(branch) {
      return branch.name === 'api/dev';
    });

    expect(branches).toHaveLength(1);
  });
});

async function waitForEvent(events: string[], event: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (events.includes(event)) {
      return;
    }
    await Bun.sleep(10);
  }

  throw new Error(`Timed out waiting for ${event}`);
}

async function createBranchLikeService(state: StateManager, branchId: string): Promise<string> {
  return state.withOperationLock(async function runCreateBranch() {
    await state.load();

    const project = state.projects.getByName('api');
    if (!project) {
      throw new Error('Project not found');
    }

    if (project.branches.some(function hasBranch(branch) {
      return branch.name === 'api/dev';
    })) {
      throw new Error("Branch 'api/dev' already exists");
    }

    await Bun.sleep(100);

    const branch = createBranch({
      id: branchId,
      name: 'api/dev',
      parentBranchId: 'branch-1',
      isPrimary: false,
    });

    await state.branches.add(project.id, branch);
    return branch.id;
  });
}

function createProject(): Project {
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
    branches: [
      createBranch({
        id: 'branch-1',
        name: 'api/main',
        parentBranchId: null,
        isPrimary: true,
      }),
    ],
  };
}

function createBranch(overrides: Partial<Branch>): Branch {
  return {
    id: 'branch-id',
    name: 'api/main',
    projectName: 'api',
    parentBranchId: null,
    isPrimary: true,
    snapshotName: null,
    zfsDataset: 'api.main',
    containerName: 'velo-api.main',
    port: 5432,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
    ...overrides,
  };
}
