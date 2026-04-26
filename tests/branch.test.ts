/**
 * Branch operations tests
 * Using direct command imports
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as cleanup from './helpers/cleanup';
import { datasetExists } from './helpers/zfs';
import { isContainerRunning } from './helpers/docker';
import { getState } from './helpers/database';
import { waitForProjectReady, waitForBranchReady } from './helpers/wait';
import {
  silenceConsole,
  projectCreateCommand,
  branchCreateCommand,
  branchListCommand,
  branchGetCommand,
  branchDeleteCommand,
} from './helpers/commands';

describe('Branch Operations', () => {
  let setupDone = false;

  async function ensureSetup() {
    if (setupDone) return;
    setupDone = true;

    silenceConsole();
    await cleanup.beforeAll();

    // Setup: Create a project
    await projectCreateCommand('test-branch', {});
    await waitForProjectReady('test-branch');
  }

  afterAll(async () => {
    await cleanup.afterAll();
  });

  describe('Create Branch', () => {
    test('should create branch from main', async () => {
      await ensureSetup();
      await branchCreateCommand('test-branch/dev', {});
      await waitForBranchReady('test-branch', 'dev');

      // Verify ZFS dataset
      expect(await datasetExists('test-branch.dev')).toBe(true);

      // Verify container running
      expect(await isContainerRunning('test-branch.dev')).toBe(true);
    }, { timeout: 30000 });

    test('should create branch with --parent flag', async () => {
      await branchCreateCommand('test-branch/staging', { parent: 'test-branch/dev' });
      await waitForBranchReady('test-branch', 'staging');

      expect(await datasetExists('test-branch.staging')).toBe(true);
      expect(await isContainerRunning('test-branch.staging')).toBe(true);
    }, { timeout: 30000 });

    test('should fail to create duplicate branch', async () => {
      await expect(branchCreateCommand('test-branch/dev', {})).rejects.toThrow();
    });

    test('should fail to create branch from non-existent parent', async () => {
      await expect(
        branchCreateCommand('test-branch/new', { parent: 'test-branch/non-existent' })
      ).rejects.toThrow();
    });
  });

  describe('List Branches', () => {
    test('should list all branches', async () => {
      // Verify via state
      const state = await getState();
      const allBranches = state.projects?.flatMap((p: any) => p.branches) || [];

      expect(allBranches.some((b: any) => b.name === 'test-branch/main')).toBe(true);
      expect(allBranches.some((b: any) => b.name === 'test-branch/dev')).toBe(true);
      expect(allBranches.some((b: any) => b.name === 'test-branch/staging')).toBe(true);
    });

    test('should list branches for specific project', async () => {
      const state = await getState();
      const project = state.projects?.find((p: any) => p.name === 'test-branch');

      expect(project).toBeDefined();
      expect(project.branches.some((b: any) => b.name === 'test-branch/main')).toBe(true);
      expect(project.branches.some((b: any) => b.name === 'test-branch/dev')).toBe(true);
    });
  });

  describe('Get Branch', () => {
    test('should get branch details', async () => {
      await branchGetCommand('test-branch/dev');
    });

    test('should fail to get non-existent branch', async () => {
      await expect(branchGetCommand('test-branch/non-existent')).rejects.toThrow();
    });
  });

  describe('Delete Branch', () => {
    test('should delete branch', async () => {
      await branchDeleteCommand('test-branch/staging');

      // Verify ZFS dataset removed
      expect(await datasetExists('test-branch.staging')).toBe(false);

      // Verify not in state
      const state = await getState();
      const project = state.projects?.find((p: any) => p.name === 'test-branch');
      const branch = project?.branches?.find((b: any) => b.name === 'test-branch/staging');
      expect(branch).toBeUndefined();
    }, { timeout: 15000 });

    test('should fail to delete main branch', async () => {
      await expect(branchDeleteCommand('test-branch/main')).rejects.toThrow();
    });

    test('should fail to delete non-existent branch', async () => {
      await expect(branchDeleteCommand('test-branch/non-existent')).rejects.toThrow();
    });
  });
});
