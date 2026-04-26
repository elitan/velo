/**
 * Cleanup command tests
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as cleanup from './helpers/cleanup';
import { getState } from './helpers/database';
import { waitForProjectReady } from './helpers/wait';
import { datasetExists } from './helpers/zfs';
import { containerExists } from './helpers/docker';
import {
  silenceConsole,
  projectCreateCommand,
  branchCreateCommand,
} from './helpers/commands';
import { $ } from 'bun';
import { CONTAINER_PREFIX } from '../src/config/constants';
import { StateManager } from '../src/managers/state';
import { ZFSManager } from '../src/managers/zfs';
import { DockerManager } from '../src/managers/docker';
import { PATHS } from '../src/utils/paths';
import { detectOrphans } from '../src/utils/orphan-detection';
import { cleanupCommand } from '../src/commands/cleanup';

describe('Cleanup Command', () => {
  beforeAll(async () => {
    silenceConsole();
    await cleanup.beforeAll();
  });

  afterAll(async () => {
    await cleanup.afterAll();
  });

  test('should report no orphans when all resources are tracked', async () => {
    // Create a normal project
    await projectCreateCommand('api', {});
    await waitForProjectReady('api');

    // Initialize managers
    const state = new StateManager(PATHS.STATE);
    await state.load();
    const stateData = state.getState();

    const zfs = new ZFSManager(stateData.zfsPool, stateData.zfsDatasetBase);
    const docker = new DockerManager();

    // Detect orphans
    const result = await detectOrphans(stateData, zfs, docker);

    // Should find no orphans
    expect(result.datasets).toHaveLength(0);
    expect(result.containers).toHaveLength(0);
    expect(result.totalOrphans).toBe(0);
  }, { timeout: 60000 });

  test('should detect orphans but not delete in dry-run mode', async () => {
    // Get state config
    const state = new StateManager(PATHS.STATE);
    await state.load();
    const stateData = state.getState();

    // Create orphaned resources
    const orphanDatasetName = 'cleanup-dryrun-test';
    const orphanContainerName = `${CONTAINER_PREFIX}-cleanup-dryrun-container`;
    const fullPath = `${stateData.zfsPool}/${stateData.zfsDatasetBase}/${orphanDatasetName}`;

    await $`sudo zfs create ${fullPath}`.quiet();
    await $`docker run -d --name ${orphanContainerName} postgres:17-alpine sleep infinity`.quiet();

    // Verify they exist
    expect(await datasetExists(orphanDatasetName)).toBe(true);
    expect(await containerExists(orphanContainerName)).toBe(true);

    // Run cleanup in dry-run mode
    await cleanupCommand({ dryRun: true });

    // Verify resources still exist (not deleted)
    expect(await datasetExists(orphanDatasetName)).toBe(true);
    expect(await containerExists(orphanContainerName)).toBe(true);

    // Cleanup
    await $`docker rm -f ${orphanContainerName}`.quiet();
    await $`sudo zfs destroy ${fullPath}`.quiet();
  }, { timeout: 30000 });

  test('should delete orphans with force flag', async () => {
    // Get state config
    const state = new StateManager(PATHS.STATE);
    await state.load();
    const stateData = state.getState();

    // Create orphaned resources
    const orphanDatasetName = 'cleanup-force-test';
    const orphanContainerName = `${CONTAINER_PREFIX}-cleanup-force-container`;
    const fullPath = `${stateData.zfsPool}/${stateData.zfsDatasetBase}/${orphanDatasetName}`;

    await $`sudo zfs create ${fullPath}`.quiet();
    await $`docker run -d --name ${orphanContainerName} postgres:17-alpine sleep infinity`.quiet();

    // Verify they exist
    expect(await datasetExists(orphanDatasetName)).toBe(true);
    expect(await containerExists(orphanContainerName)).toBe(true);

    // Run cleanup with force flag
    await cleanupCommand({ force: true });

    // Verify resources were deleted
    expect(await datasetExists(orphanDatasetName)).toBe(false);
    expect(await containerExists(orphanContainerName)).toBe(false);
  }, { timeout: 30000 });

  test('should not delete tracked resources', async () => {
    // Create a normal branch
    await branchCreateCommand('api/test-branch', {});

    // Get state to verify branch exists
    const stateData = await getState();
    const project = stateData.projects.find((p: any) => p.name === 'api');
    expect(project).toBeDefined();
    const branch = project.branches.find((b: any) => b.name === 'api/test-branch');
    expect(branch).toBeDefined();

    // Create an orphaned resource
    const orphanDatasetName = 'cleanup-tracked-test';
    const orphanContainerName = `${CONTAINER_PREFIX}-cleanup-tracked-container`;
    const state = new StateManager(PATHS.STATE);
    await state.load();
    const stateConfig = state.getState();
    const fullPath = `${stateConfig.zfsPool}/${stateConfig.zfsDatasetBase}/${orphanDatasetName}`;

    await $`sudo zfs create ${fullPath}`.quiet();
    await $`docker run -d --name ${orphanContainerName} postgres:17-alpine sleep infinity`.quiet();

    // Run cleanup
    await cleanupCommand({ force: true });

    // Verify tracked branch resources still exist
    expect(await datasetExists('api.test-branch')).toBe(true);
    expect(await containerExists(`${CONTAINER_PREFIX}-api.test-branch`)).toBe(true);

    // Verify orphaned resources were deleted
    expect(await datasetExists(orphanDatasetName)).toBe(false);
    expect(await containerExists(orphanContainerName)).toBe(false);
  }, { timeout: 60000 });

  test('should handle multiple orphaned datasets and containers', async () => {
    // Get state config
    const state = new StateManager(PATHS.STATE);
    await state.load();
    const stateData = state.getState();

    // Create multiple orphaned resources
    const orphans = [
      { dataset: 'orphan-multi-1', container: `${CONTAINER_PREFIX}-orphan-multi-1` },
      { dataset: 'orphan-multi-2', container: `${CONTAINER_PREFIX}-orphan-multi-2` },
      { dataset: 'orphan-multi-3', container: `${CONTAINER_PREFIX}-orphan-multi-3` },
    ];

    for (const orphan of orphans) {
      const fullPath = `${stateData.zfsPool}/${stateData.zfsDatasetBase}/${orphan.dataset}`;
      await $`sudo zfs create ${fullPath}`.quiet();
      await $`docker run -d --name ${orphan.container} postgres:17-alpine sleep infinity`.quiet();
    }

    // Verify they exist
    for (const orphan of orphans) {
      expect(await datasetExists(orphan.dataset)).toBe(true);
      expect(await containerExists(orphan.container)).toBe(true);
    }

    // Run cleanup
    await cleanupCommand({ force: true });

    // Verify all were deleted
    for (const orphan of orphans) {
      expect(await datasetExists(orphan.dataset)).toBe(false);
      expect(await containerExists(orphan.container)).toBe(false);
    }
  }, { timeout: 60000 });

  test('should handle partial failures gracefully', async () => {
    // Get state config
    const state = new StateManager(PATHS.STATE);
    await state.load();
    const stateData = state.getState();

    // Create orphaned dataset
    const orphanDatasetName = 'cleanup-partial-fail';
    const fullPath = `${stateData.zfsPool}/${stateData.zfsDatasetBase}/${orphanDatasetName}`;
    await $`sudo zfs create ${fullPath}`.quiet();

    // Create a valid orphaned container
    const orphanContainerName = `${CONTAINER_PREFIX}-cleanup-partial-container`;
    await $`docker run -d --name ${orphanContainerName} postgres:17-alpine sleep infinity`.quiet();

    // Verify they exist
    expect(await datasetExists(orphanDatasetName)).toBe(true);
    expect(await containerExists(orphanContainerName)).toBe(true);

    // Run cleanup (should succeed for both)
    await cleanupCommand({ force: true });

    // Verify both were deleted
    expect(await datasetExists(orphanDatasetName)).toBe(false);
    expect(await containerExists(orphanContainerName)).toBe(false);
  }, { timeout: 30000 });
});
