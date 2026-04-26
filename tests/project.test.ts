/**
 * Project CRUD operations tests
 * Using direct command imports (not CLI subprocess spawning)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as cleanup from './helpers/cleanup';
import { datasetExists } from './helpers/zfs';
import { isContainerRunning } from './helpers/docker';
import { getState } from './helpers/database';
import { waitForProjectReady } from './helpers/wait';
import {
  silenceConsole,
  projectCreateCommand,
  projectListCommand,
  projectGetCommand,
  projectDeleteCommand,
} from './helpers/commands';

describe('Project Operations', () => {
  beforeAll(async () => {
    silenceConsole(); // Silence all console output
    await cleanup.beforeAll();
  });

  afterAll(async () => {
    await cleanup.afterAll();
  });

  describe('Create Project', () => {
    test('should create first project and auto-initialize', async () => {
      await projectCreateCommand('api', {});
      await waitForProjectReady('api');

      // Verify ZFS dataset
      expect(await datasetExists('api.main')).toBe(true);

      // Verify container running
      expect(await isContainerRunning('api.main')).toBe(true);
    }, { timeout: 30000 });

    test('should create second project', async () => {
      await projectCreateCommand('web', {});
      await waitForProjectReady('web');

      expect(await datasetExists('web.main')).toBe(true);
      expect(await isContainerRunning('web.main')).toBe(true);
    }, { timeout: 30000 });

    test('should fail to create duplicate project', async () => {
      await expect(projectCreateCommand('api', {})).rejects.toThrow('already exists');
    });
  });

  describe('List Projects', () => {
    test('should list all projects', async () => {
      // Note: projectListCommand doesn't return anything, it just logs
      // We verify via state instead
      const state = await getState();
      expect(state.projects).toBeDefined();
      expect(state.projects.length).toBeGreaterThanOrEqual(2);

      const projectNames = state.projects.map((p: any) => p.name);
      expect(projectNames).toContain('api');
      expect(projectNames).toContain('web');
    });
  });

  describe('Get Project', () => {
    test('should get project details', async () => {
      // Should complete without throwing
      await projectGetCommand('api');
    });

    test('should fail to get non-existent project', async () => {
      await expect(projectGetCommand('non-existent')).rejects.toThrow();
    });
  });

  describe('Delete Project', () => {
    test('should delete project and all branches', async () => {
      await projectDeleteCommand('web', {});

      // Verify ZFS dataset removed
      expect(await datasetExists('web.main')).toBe(false);

      // Verify not in state
      const state = await getState();
      const project = state.projects?.find((p: any) => p.name === 'web');
      expect(project).toBeUndefined();
    }, { timeout: 15000 });

    test('should fail to delete non-existent project', async () => {
      await expect(projectDeleteCommand('non-existent', {})).rejects.toThrow();
    });
  });
});
