/**
 * Branch deletion with --force flag tests
 * Tests cascade deletion of branches with children
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
  branchDeleteCommand,
} from './helpers/commands';

describe('Branch Delete with --force', () => {
  let setupDone = false;

  async function ensureSetup() {
    if (setupDone) return;
    setupDone = true;

    // Set test mode for proper error handling
    process.env.NODE_ENV = 'test';

    silenceConsole();
    await cleanup.beforeAll();

    // Setup: Create a project
    await projectCreateCommand('force-test', {});
    await waitForProjectReady('force-test');
  }

  afterAll(async () => {
    await cleanup.afterAll();
  });

  describe('Delete branch without children', () => {
    test('should delete branch without --force when no children exist', async () => {
      await ensureSetup();

      // Create a simple branch
      await branchCreateCommand('force-test/simple', {});
      await waitForBranchReady('force-test', 'simple');

      // Verify it exists
      expect(await datasetExists('force-test.simple')).toBe(true);
      expect(await isContainerRunning('force-test.simple')).toBe(true);

      // Delete without --force (should work fine)
      await branchDeleteCommand('force-test/simple', {});

      // Verify deletion
      expect(await datasetExists('force-test.simple')).toBe(false);
      expect(await isContainerRunning('force-test.simple')).toBe(false);

      const state = await getState();
      const project = state.projects?.find((p: any) => p.name === 'force-test');
      const branch = project?.branches?.find((b: any) => b.name === 'force-test/simple');
      expect(branch).toBeUndefined();
    }, { timeout: 30000 });
  });

  describe('Delete branch with children - should fail without --force', () => {
    test('should fail to delete branch with children when --force is not provided', async () => {
      // Create parent branch
      await branchCreateCommand('force-test/parent', {});
      await waitForBranchReady('force-test', 'parent');

      // Create child branch
      await branchCreateCommand('force-test/child', { parent: 'force-test/parent' });
      await waitForBranchReady('force-test', 'child');

      // Verify both exist
      expect(await datasetExists('force-test.parent')).toBe(true);
      expect(await datasetExists('force-test.child')).toBe(true);

      // Try to delete parent without --force - should fail
      await expect(
        branchDeleteCommand('force-test/parent', {})
      ).rejects.toThrow();

      // Verify parent and child still exist
      expect(await datasetExists('force-test.parent')).toBe(true);
      expect(await datasetExists('force-test.child')).toBe(true);
      expect(await isContainerRunning('force-test.parent')).toBe(true);
      expect(await isContainerRunning('force-test.child')).toBe(true);

      const state = await getState();
      const project = state.projects?.find((p: any) => p.name === 'force-test');
      expect(project?.branches?.find((b: any) => b.name === 'force-test/parent')).toBeDefined();
      expect(project?.branches?.find((b: any) => b.name === 'force-test/child')).toBeDefined();
    }, { timeout: 30000 });
  });

  describe('Delete branch with children using --force', () => {
    test('should delete branch and all children with --force', async () => {
      // Verify parent and child exist from previous test
      expect(await datasetExists('force-test.parent')).toBe(true);
      expect(await datasetExists('force-test.child')).toBe(true);

      // Delete parent with --force - should succeed
      await branchDeleteCommand('force-test/parent', { force: true });

      // Verify both parent and child are deleted
      expect(await datasetExists('force-test.parent')).toBe(false);
      expect(await datasetExists('force-test.child')).toBe(false);
      expect(await isContainerRunning('force-test.parent')).toBe(false);
      expect(await isContainerRunning('force-test.child')).toBe(false);

      const state = await getState();
      const project = state.projects?.find((p: any) => p.name === 'force-test');
      expect(project?.branches?.find((b: any) => b.name === 'force-test/parent')).toBeUndefined();
      expect(project?.branches?.find((b: any) => b.name === 'force-test/child')).toBeUndefined();
    }, { timeout: 30000 });
  });

  describe('Delete branch with multi-level descendants using --force', () => {
    test('should delete branch and all nested descendants with --force', async () => {
      // Create a tree structure:
      // main
      //   └─ level1
      //       ├─ level2a
      //       │   └─ level3
      //       └─ level2b

      // Create level1
      await branchCreateCommand('force-test/level1', {});
      await waitForBranchReady('force-test', 'level1');

      // Create level2a (child of level1)
      await branchCreateCommand('force-test/level2a', { parent: 'force-test/level1' });
      await waitForBranchReady('force-test', 'level2a');

      // Small delay to ensure unique snapshot timestamps (snapshots use second-precision)
      await Bun.sleep(1000);

      // Create level2b (child of level1)
      await branchCreateCommand('force-test/level2b', { parent: 'force-test/level1' });
      await waitForBranchReady('force-test', 'level2b');

      // Create level3 (child of level2a)
      await branchCreateCommand('force-test/level3', { parent: 'force-test/level2a' });
      await waitForBranchReady('force-test', 'level3');

      // Verify all branches exist
      expect(await datasetExists('force-test.level1')).toBe(true);
      expect(await datasetExists('force-test.level2a')).toBe(true);
      expect(await datasetExists('force-test.level2b')).toBe(true);
      expect(await datasetExists('force-test.level3')).toBe(true);

      // Delete level1 with --force - should delete all descendants
      await branchDeleteCommand('force-test/level1', { force: true });

      // Verify all are deleted
      expect(await datasetExists('force-test.level1')).toBe(false);
      expect(await datasetExists('force-test.level2a')).toBe(false);
      expect(await datasetExists('force-test.level2b')).toBe(false);
      expect(await datasetExists('force-test.level3')).toBe(false);

      expect(await isContainerRunning('force-test.level1')).toBe(false);
      expect(await isContainerRunning('force-test.level2a')).toBe(false);
      expect(await isContainerRunning('force-test.level2b')).toBe(false);
      expect(await isContainerRunning('force-test.level3')).toBe(false);

      // Verify state is clean
      const state = await getState();
      const project = state.projects?.find((p: any) => p.name === 'force-test');
      expect(project?.branches?.find((b: any) => b.name === 'force-test/level1')).toBeUndefined();
      expect(project?.branches?.find((b: any) => b.name === 'force-test/level2a')).toBeUndefined();
      expect(project?.branches?.find((b: any) => b.name === 'force-test/level2b')).toBeUndefined();
      expect(project?.branches?.find((b: any) => b.name === 'force-test/level3')).toBeUndefined();

      // Only main should remain
      expect(project?.branches?.length).toBe(1);
      expect(project?.branches?.[0]?.name).toBe('force-test/main');
    }, { timeout: 60000 }); // Creates 4 branches, needs extra time
  });

  describe('Delete branch with sibling branches', () => {
    test('should only delete target branch and its children, not siblings', async () => {
      // Create siblings:
      // main
      //   ├─ sibling1
      //   │   └─ sibling1-child
      //   └─ sibling2

      await branchCreateCommand('force-test/sibling1', {});
      await waitForBranchReady('force-test', 'sibling1');

      // Small delay to ensure unique snapshot timestamps (snapshots use second-precision)
      await Bun.sleep(1000);

      await branchCreateCommand('force-test/sibling2', {});
      await waitForBranchReady('force-test', 'sibling2');

      await branchCreateCommand('force-test/sibling1-child', { parent: 'force-test/sibling1' });
      await waitForBranchReady('force-test', 'sibling1-child');

      // Verify all exist
      expect(await datasetExists('force-test.sibling1')).toBe(true);
      expect(await datasetExists('force-test.sibling2')).toBe(true);
      expect(await datasetExists('force-test.sibling1-child')).toBe(true);

      // Delete sibling1 with --force
      await branchDeleteCommand('force-test/sibling1', { force: true });

      // Verify sibling1 and its child are deleted
      expect(await datasetExists('force-test.sibling1')).toBe(false);
      expect(await datasetExists('force-test.sibling1-child')).toBe(false);

      // Verify sibling2 still exists
      expect(await datasetExists('force-test.sibling2')).toBe(true);
      expect(await isContainerRunning('force-test.sibling2')).toBe(true);

      const state = await getState();
      const project = state.projects?.find((p: any) => p.name === 'force-test');
      expect(project?.branches?.find((b: any) => b.name === 'force-test/sibling1')).toBeUndefined();
      expect(project?.branches?.find((b: any) => b.name === 'force-test/sibling1-child')).toBeUndefined();
      expect(project?.branches?.find((b: any) => b.name === 'force-test/sibling2')).toBeDefined();
    }, { timeout: 60000 }); // Creates 3 branches, needs extra time
  });
});
