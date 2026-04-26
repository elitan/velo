import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getStateInfo } from './state-info-service';
import { StateManager } from '../managers/state';

describe('getStateInfo', function () {
  const testDir = '/tmp/velo-state-info-test';
  const stateFile = path.join(testDir, 'state.json');
  const backupFile = `${stateFile}.backup`;

  beforeEach(async function () {
    await fs.rm(testDir, { recursive: true, force: true });
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async function () {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('reports missing state', async function () {
    const info = await getStateInfo(stateFile);

    expect(info.exists).toBe(false);
    expect(info.initialized).toBe(false);
    expect(info.schemaStatus).toBe('missing');
    expect(info.currentSchemaVersion).toBe(2);
    expect(info.backup.exists).toBe(false);
  });

  test('reports current initialized state', async function () {
    const state = new StateManager(stateFile);
    await state.initialize('tank', 'velo/databases');

    const info = await getStateInfo(stateFile);

    expect(info.exists).toBe(true);
    expect(info.initialized).toBe(true);
    expect(info.schemaVersion).toBe(2);
    expect(info.schemaStatus).toBe('current');
    expect(info.projectCount).toBe(0);
    expect(info.branchCount).toBe(0);
    expect(info.snapshotCount).toBe(0);
    expect(info.zfsPool).toBe('tank');
    expect(info.zfsDatasetBase).toBe('velo/databases');
  });

  test('migrates legacy state and reports backup', async function () {
    await fs.writeFile(stateFile, JSON.stringify({
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
      snapshots: [
        {
          id: 'snapshot-1',
          branchId: 'branch-1',
          branchName: 'api/main',
          projectName: 'api',
          zfsSnapshot: 'tank/velo/databases/api-main@snapshot-1',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }, null, 2), 'utf-8');

    const info = await getStateInfo(stateFile);

    expect(info.initialized).toBe(true);
    expect(info.schemaVersion).toBe(2);
    expect(info.schemaStatus).toBe('migrated');
    expect(info.migrationApplied).toBe(true);
    expect(info.projectCount).toBe(1);
    expect(info.branchCount).toBe(1);
    expect(info.snapshotCount).toBe(1);
    expect(info.zfsDatasetBase).toBe('velo/databases');
    expect(info.backup.exists).toBe(true);

    const backup = JSON.parse(await fs.readFile(backupFile, 'utf-8'));
    expect(backup.schemaVersion).toBeUndefined();
  });

  test('reports unsupported future schema without loading it', async function () {
    await fs.writeFile(stateFile, JSON.stringify({
      schemaVersion: 999,
      version: '1.0.0',
      initializedAt: '2026-01-01T00:00:00.000Z',
      zfsPool: 'tank',
      zfsDatasetBase: 'velo/databases',
      projects: [],
      snapshots: [],
    }, null, 2), 'utf-8');

    const info = await getStateInfo(stateFile);

    expect(info.initialized).toBe(false);
    expect(info.schemaVersion).toBe(999);
    expect(info.schemaStatus).toBe('unsupported');
    expect(info.error).toContain('Unsupported state schema version');
  });
});
