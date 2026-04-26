import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import { StateManager } from '../src/managers/state';

describe('State migration', function () {
  const testDir = '/tmp/velo-state-migration-test';
  const stateFile = path.join(testDir, 'state.json');
  const backupFile = `${stateFile}.backup`;

  beforeEach(async function () {
    await fs.rm(testDir, { recursive: true, force: true });
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async function () {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('writes current schema version for new state', async function () {
    const state = new StateManager(stateFile);

    await state.initialize('tank', 'velo/databases');

    const stateData = state.getState();
    expect(stateData.schemaVersion).toBe(2);
  });

  test('migrates legacy state on load and keeps a backup', async function () {
    await writeState({
      version: '1.0.0',
      initializedAt: '2026-01-01T00:00:00.000Z',
      zfsPool: 'tank',
      zfsDatasetBase: 'tank/velo/databases',
      projects: [
        {
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
            {
              id: 'branch-1',
              name: 'api/main',
              projectName: 'api',
              parentBranchId: null,
              isPrimary: true,
              snapshotName: null,
              zfsDataset: 'api-main',
              port: 5432,
              createdAt: '2026-01-01T00:00:00.000Z',
              status: 'running',
            },
          ],
        },
      ],
      snapshots: [],
    });

    const state = new StateManager(stateFile);
    await state.load();

    const stateData = state.getState();
    const branch = stateData.projects[0]!.branches[0]!;

    expect(stateData.schemaVersion).toBe(2);
    expect(stateData.zfsDatasetBase).toBe('velo/databases');
    expect(branch.zfsDataset).toBe('api-main');
    expect(branch.containerName).toBe('velo-api-main');

    const persisted = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    expect(persisted.schemaVersion).toBe(2);
    expect(persisted.projects[0].branches[0].containerName).toBe('velo-api-main');

    const backup = JSON.parse(await fs.readFile(backupFile, 'utf-8'));
    expect(backup.schemaVersion).toBeUndefined();
    expect(backup.zfsDatasetBase).toBe('tank/velo/databases');
  });

  test('keeps existing container names during migration', async function () {
    await writeState({
      version: '1.0.0',
      initializedAt: '2026-01-01T00:00:00.000Z',
      zfsPool: 'tank',
      zfsDatasetBase: 'velo/databases',
      projects: [
        {
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
            {
              id: 'branch-1',
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
            },
          ],
        },
      ],
      snapshots: [],
    });

    const state = new StateManager(stateFile);
    await state.load();

    const branch = state.getState().projects[0]!.branches[0]!;
    expect(branch.containerName).toBe('velo-api.main');
  });

  test('rejects state from a newer schema', async function () {
    await writeState({
      schemaVersion: 999,
      version: '1.0.0',
      initializedAt: '2026-01-01T00:00:00.000Z',
      zfsPool: 'tank',
      zfsDatasetBase: 'velo/databases',
      projects: [],
      snapshots: [],
    });

    const state = new StateManager(stateFile);
    await expect(state.load()).rejects.toThrow('Unsupported state schema version');
  });

  async function writeState(data: unknown): Promise<void> {
    await fs.writeFile(stateFile, JSON.stringify(data, null, 2), 'utf-8');
  }
});
