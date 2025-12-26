/**
 * WAL (Write-Ahead Log) operations tests
 * Using direct command imports
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { $ } from 'bun';
import * as cleanup from './helpers/cleanup';
import { getProjectCredentials, getBranchPort, waitForReady } from './helpers/database';
import {
  silenceConsole,
  projectCreateCommand,
  walInfoCommand,
  walCleanupCommand,
} from './helpers/commands';
import { WALManager } from '../src/managers/wal';
import { PATHS } from '../src/utils/paths';

describe('WAL Operations', () => {
  let setupDone = false;

  async function ensureSetup() {
    if (setupDone) return;
    setupDone = true;

    silenceConsole();
    await cleanup.beforeAll();

    // Setup: Create project
    await projectCreateCommand('wal-test', {});
    const creds = await getProjectCredentials('wal-test');
    const port = await getBranchPort('wal-test/main');
    await waitForReady(port, creds.password, 60000);
  }

  afterAll(async () => {
    await cleanup.afterAll();
  });

  describe('WAL Info', () => {
    test('should show WAL info for all branches', async () => {
      await ensureSetup();
      await walInfoCommand(undefined);
    }, { timeout: 60000 });

    test('should show WAL info for specific branch', async () => {
      await ensureSetup();
      await walInfoCommand('wal-test/main');
    }, { timeout: 60000 });

    test('should fail for non-existent branch', async () => {
      await expect(walInfoCommand('wal-test/non-existent')).rejects.toThrow();
    });
  });

  describe('WAL Cleanup', () => {
    test('should cleanup old WAL files', async () => {
      await ensureSetup();
      await walCleanupCommand('wal-test/main', { days: 30 });
    }, { timeout: 60000 });

    test('should fail to cleanup non-existent branch', async () => {
      await expect(walCleanupCommand('wal-test/non-existent', { days: 30 })).rejects.toThrow();
    });
  });

  describe('WAL Archive Permissions', () => {
    test('should set restrictive permissions (770) on WAL archive directory', async () => {
      const wal = new WALManager();
      const testDataset = 'permission-test';
      const archivePath = `${PATHS.WAL_ARCHIVE}/${testDataset}`;

      // Clean up any existing test directory
      await $`rm -rf ${archivePath}`.quiet().nothrow();

      // Create the archive directory
      await wal.ensureArchiveDir(testDataset);

      // Verify permissions are 770 (not 777)
      const stat = await $`stat -c '%a' ${archivePath}`.text();
      expect(stat.trim()).toBe('770');

      // Verify ownership is 70:70 (postgres user/group)
      const owner = await $`stat -c '%u:%g' ${archivePath}`.text();
      expect(owner.trim()).toBe('70:70');

      // Clean up
      await $`rm -rf ${archivePath}`.quiet().nothrow();
    });
  });
});
