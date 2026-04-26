/**
 * Integration tests for ZFS, Docker, and state management
 * Using direct command imports
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as cleanup from './helpers/cleanup';
import { getDatasetSize, getDatasetName } from './helpers/zfs';
import { getProjectCredentials, getBranchPort, query, waitForReady, getState } from './helpers/database';
import { waitForProjectReady, waitForBranchReady } from './helpers/wait';
import { isContainerRunning } from './helpers/docker';
import {
  silenceConsole,
  projectCreateCommand,
  branchCreateCommand,
} from './helpers/commands';

describe('Integration Tests', () => {
  beforeAll(async () => {
    silenceConsole();
    await cleanup.beforeAll();
  });

  afterAll(async () => {
    await cleanup.afterAll();
  });

  describe('ZFS Copy-on-Write Efficiency', () => {
    test('branches should use less space than parent due to CoW', async () => {
      // Create project with some data
      await projectCreateCommand('cow-test', {});
      await waitForProjectReady('cow-test');

      const creds = await getProjectCredentials('cow-test');
      const mainPort = await getBranchPort('cow-test/main');

      // Add significant data to parent
      await query(mainPort, creds.password, 'CREATE TABLE large_data (id SERIAL PRIMARY KEY, data TEXT);');
      for (let i = 0; i < 100; i++) {
        await query(mainPort, creds.password, `INSERT INTO large_data (data) VALUES ('${'x'.repeat(1000)}');`);
      }

      // Get parent size
      const parentSize = await getDatasetSize(getDatasetName('cow-test', 'main'));

      // Create branches
      await branchCreateCommand('cow-test/dev', {});
      await waitForBranchReady('cow-test', 'dev');

      // Small delay to ensure unique snapshot timestamps (snapshots use second-precision)
      await Bun.sleep(1000);

      await branchCreateCommand('cow-test/staging', {});
      await waitForBranchReady('cow-test', 'staging');

      // Get branch sizes
      const devSize = await getDatasetSize(getDatasetName('cow-test', 'dev'));
      const stagingSize = await getDatasetSize(getDatasetName('cow-test', 'staging'));

      // Branches should be much smaller due to CoW
      expect(devSize).toBeLessThan(parentSize);
      expect(stagingSize).toBeLessThan(parentSize);
    }, { timeout: 60000 }); // Inserts 100 rows, needs extra time
  });

  describe('State Integrity', () => {
    test('state should track all projects and branches', async () => {
      await projectCreateCommand('state-test-1', {});
      await waitForProjectReady('state-test-1');
      await projectCreateCommand('state-test-2', {});
      await waitForProjectReady('state-test-2');
      await branchCreateCommand('state-test-1/dev', {});
      await waitForBranchReady('state-test-1', 'dev');

      // Small delay to ensure unique snapshot timestamps
      await Bun.sleep(1000);

      await branchCreateCommand('state-test-1/staging', {});
      await waitForBranchReady('state-test-1', 'staging');

      const state = await getState();

      // Verify projects exist
      const project1 = state.projects?.find((p: any) => p.name === 'state-test-1');
      const project2 = state.projects?.find((p: any) => p.name === 'state-test-2');
      expect(project1).toBeDefined();
      expect(project2).toBeDefined();

      // Verify branches exist
      expect(project1?.branches?.length).toBe(3); // main, dev, staging
      expect(project2?.branches?.length).toBe(1); // main
    }, { timeout: 90000 });

    test('state should have valid connection credentials', async () => {
      const state = await getState();

      for (const project of state.projects || []) {
        expect(project.credentials).toBeDefined();
        expect(project.credentials.username).toBe('postgres');
        expect(project.credentials.password).toBeDefined();
        expect(project.credentials.password.length).toBeGreaterThan(0);
        expect(project.credentials.database).toBe('postgres');
      }
    });
  });

  describe('Docker Integration', () => {
    test('all running branches should have containers', async () => {
      const state = await getState();

      for (const project of state.projects || []) {
        for (const branch of project.branches || []) {
          if (branch.status === 'running') {
            const containerName = branch.containerName || `${project.name}.${branch.name.split('/')[1]}`;
            expect(await isContainerRunning(containerName)).toBe(true);
          }
        }
      }
    });
  });

  describe('Multi-Branch Scenarios', () => {
    test('should handle multiple branches from different parents', async () => {
      await projectCreateCommand('multi-test', {});
      await waitForProjectReady('multi-test');

      // Create branch from main
      await branchCreateCommand('multi-test/dev', {});
      await waitForBranchReady('multi-test', 'dev');

      // Small delay to ensure unique snapshot timestamps
      await Bun.sleep(1000);

      // Create branch from dev
      await branchCreateCommand('multi-test/feature', { parent: 'multi-test/dev' });
      await waitForBranchReady('multi-test', 'feature');

      const state = await getState();
      const project = state.projects?.find((p: any) => p.name === 'multi-test');

      expect(project?.branches?.length).toBe(3); // main, dev, feature
    }, { timeout: 60000 }); // Creates multiple branches, needs extra time
  });
});
