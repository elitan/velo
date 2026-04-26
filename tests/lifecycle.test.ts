/**
 * Lifecycle tests: start, stop, restart operations
 * Using direct command imports
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as cleanup from './helpers/cleanup';
import { isContainerRunning, isContainerStopped } from './helpers/docker';
import { getProjectCredentials, getBranchPort, query, waitForReady } from './helpers/database';
import { waitForProjectReady, waitForBranchReady, waitForContainer, waitForContainerStopped } from './helpers/wait';
import {
  silenceConsole,
  projectCreateCommand,
  branchCreateCommand,
  startCommand,
  stopCommand,
  restartCommand,
} from './helpers/commands';

describe('Lifecycle Operations', () => {
  beforeAll(async () => {
    silenceConsole();
    await cleanup.beforeAll();
  });

  afterAll(async () => {
    await cleanup.afterAll();
  });

  describe('Project Lifecycle', () => {
    test('should stop a running project', async () => {
      // Create project
      await projectCreateCommand('test-lifecycle', {});
      await waitForProjectReady('test-lifecycle');

      // Verify running
      expect(await isContainerRunning('test-lifecycle.main')).toBe(true);

      // Stop project
      await stopCommand('test-lifecycle/main');
      await waitForContainerStopped('test-lifecycle.main');

      // Verify stopped
      expect(await isContainerStopped('test-lifecycle.main')).toBe(true);
    }, { timeout: 30000 });

    test('should start a stopped project', async () => {
      // Start project
      await startCommand('test-lifecycle/main');
      await waitForContainer('test-lifecycle.main');

      // Verify running
      expect(await isContainerRunning('test-lifecycle.main')).toBe(true);
    }, { timeout: 30000 });

    test('should restart a running project', async () => {
      // Restart project
      await restartCommand('test-lifecycle/main');
      await waitForContainer('test-lifecycle.main');

      // Verify running
      expect(await isContainerRunning('test-lifecycle.main')).toBe(true);
    }, { timeout: 30000 });

    test('should persist data after stop/start cycle', async () => {
      const creds = await getProjectCredentials('test-lifecycle');
      let port = await getBranchPort('test-lifecycle/main');

      // Create test data
      await waitForReady(port, creds.password, 15000);
      await query(port, creds.password, 'CREATE TABLE lifecycle_test (id SERIAL PRIMARY KEY, value TEXT);');
      await query(port, creds.password, "INSERT INTO lifecycle_test (value) VALUES ('persistent');");

      // Stop and start
      await stopCommand('test-lifecycle/main');
      await waitForContainerStopped('test-lifecycle.main');
      await startCommand('test-lifecycle/main');
      await waitForContainer('test-lifecycle.main');

      // Get port again (might have changed after restart)
      port = await getBranchPort('test-lifecycle/main');

      // Verify data persisted
      await waitForReady(port, creds.password, 20000);
      const count = await query(port, creds.password, 'SELECT COUNT(*) FROM lifecycle_test;');
      expect(count).toBe('1');
    }, { timeout: 60000 });
  });

  describe('Branch Lifecycle', () => {
    test('should stop a branch', async () => {
      // Create branch
      await branchCreateCommand('test-lifecycle/dev', {});
      await waitForBranchReady('test-lifecycle', 'dev');

      // Verify running
      expect(await isContainerRunning('test-lifecycle.dev')).toBe(true);

      // Stop branch
      await stopCommand('test-lifecycle/dev');
      await waitForContainerStopped('test-lifecycle.dev');

      // Verify stopped
      expect(await isContainerStopped('test-lifecycle.dev')).toBe(true);
    }, { timeout: 30000 });

    test('should start a stopped branch', async () => {
      // Start branch
      await startCommand('test-lifecycle/dev');
      await waitForContainer('test-lifecycle.dev');

      // Verify running
      expect(await isContainerRunning('test-lifecycle.dev')).toBe(true);
    }, { timeout: 30000 });

    test('should restart a branch', async () => {
      // Restart branch
      await restartCommand('test-lifecycle/dev');
      await waitForContainer('test-lifecycle.dev');

      // Verify running
      expect(await isContainerRunning('test-lifecycle.dev')).toBe(true);
    }, { timeout: 30000 });
  });

  describe('Idempotent Operations', () => {
    test('should handle start on already running container', async () => {
      await startCommand('test-lifecycle/main');
      expect(await isContainerRunning('test-lifecycle.main')).toBe(true);
    }, { timeout: 15000 });

    test('should handle stop on already stopped container', async () => {
      await stopCommand('test-lifecycle/dev');
      await waitForContainerStopped('test-lifecycle.dev');

      await stopCommand('test-lifecycle/dev');
      expect(await isContainerStopped('test-lifecycle.dev')).toBe(true);

      // Start it back up for other tests
      await startCommand('test-lifecycle/dev');
      await waitForContainer('test-lifecycle.dev');
    }, { timeout: 30000 });
  });

  describe('Edge Cases', () => {
    test('should fail to stop non-existent branch', async () => {
      await expect(stopCommand('non-existent/branch')).rejects.toThrow();
    });

    test('should fail to start non-existent branch', async () => {
      await expect(startCommand('non-existent/branch')).rejects.toThrow();
    });

    test('should fail to restart non-existent branch', async () => {
      await expect(restartCommand('non-existent/branch')).rejects.toThrow();
    });
  });
});
