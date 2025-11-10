/**
 * Orphan detection tests
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as cleanup from './helpers/cleanup';
import { getState } from './helpers/database';
import { waitForProjectReady, waitForBranchReady } from './helpers/wait';
import { datasetExists } from './helpers/zfs';
import { containerExists } from './helpers/docker';
import {
  silenceConsole,
  projectCreateCommand,
  branchCreateCommand,
} from './helpers/commands';
import { StateManager } from '../src/managers/state';
import { ZFSManager } from '../src/managers/zfs';
import { DockerManager } from '../src/managers/docker';
import { detectOrphans } from '../src/utils/orphan-detection';
import { formatBytes } from '../src/utils/helpers';
import { $ } from 'bun';
import { CONTAINER_PREFIX } from '../src/config/constants';
import { PATHS } from '../src/utils/paths';

describe('Orphan Detection', () => {
  beforeAll(async () => {
    silenceConsole();
    await cleanup.beforeAll();
  });

  afterAll(async () => {
    await cleanup.afterAll();
  });

  test('should detect no orphans when all resources are tracked', async () => {
    // Create a normal project
    await projectCreateCommand('api', {});
    await waitForProjectReady('api');

    // Create a branch
    await branchCreateCommand('api/dev', {});
    await waitForBranchReady('api', 'dev');

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
    expect(result.totalWastedBytes).toBe(0);
  }, { timeout: 60000 });

  test('should detect orphaned ZFS dataset', async () => {
    // Get state config
    const state = new StateManager(PATHS.STATE);
    await state.load();
    const stateData = state.getState();

    // Create an orphaned ZFS dataset manually
    const orphanDatasetName = 'orphan-test';
    const fullPath = `${stateData.zfsPool}/${stateData.zfsDatasetBase}/${orphanDatasetName}`;
    await $`sudo zfs create ${fullPath}`.quiet();

    // Verify it was created
    expect(await datasetExists(orphanDatasetName)).toBe(true);

    // Initialize managers
    const zfs = new ZFSManager(stateData.zfsPool, stateData.zfsDatasetBase);
    const docker = new DockerManager();

    // Detect orphans
    const result = await detectOrphans(stateData, zfs, docker);

    // Should find the orphaned dataset
    expect(result.datasets.length).toBeGreaterThanOrEqual(1);
    const orphanedDataset = result.datasets.find(d => d.name === orphanDatasetName);
    expect(orphanedDataset).toBeDefined();
    expect(orphanedDataset?.fullPath).toBe(fullPath);
    expect(orphanedDataset?.sizeBytes).toBeGreaterThan(0);

    // Cleanup orphan
    await $`sudo zfs destroy ${fullPath}`.quiet();
  }, { timeout: 30000 });

  test('should detect orphaned Docker container', async () => {
    // Get state config
    const state = new StateManager(PATHS.STATE);
    await state.load();
    const stateData = state.getState();

    // Create an orphaned Docker container manually
    const orphanContainerName = `${CONTAINER_PREFIX}-orphan-test`;
    await $`docker run -d --name ${orphanContainerName} postgres:17-alpine sleep infinity`.quiet();

    // Verify it was created
    expect(await containerExists(orphanContainerName)).toBe(true);

    // Initialize managers
    const zfs = new ZFSManager(stateData.zfsPool, stateData.zfsDatasetBase);
    const docker = new DockerManager();

    // Detect orphans
    const result = await detectOrphans(stateData, zfs, docker);

    // Should find the orphaned container
    expect(result.containers.length).toBeGreaterThanOrEqual(1);
    const orphanedContainer = result.containers.find(c => c.name === orphanContainerName);
    expect(orphanedContainer).toBeDefined();
    expect(orphanedContainer?.id).toBeDefined();
    expect(orphanedContainer?.state).toBeDefined();

    // Cleanup orphan
    await $`docker rm -f ${orphanContainerName}`.quiet();
  }, { timeout: 30000 });

  test('should detect both orphaned datasets and containers', async () => {
    // Get state config
    const state = new StateManager(PATHS.STATE);
    await state.load();
    const stateData = state.getState();

    // Create orphaned resources
    const orphanDatasetName = 'multi-orphan-dataset';
    const orphanContainerName = `${CONTAINER_PREFIX}-multi-orphan-container`;
    const fullPath = `${stateData.zfsPool}/${stateData.zfsDatasetBase}/${orphanDatasetName}`;

    await $`sudo zfs create ${fullPath}`.quiet();
    await $`docker run -d --name ${orphanContainerName} postgres:17-alpine sleep infinity`.quiet();

    // Initialize managers
    const zfs = new ZFSManager(stateData.zfsPool, stateData.zfsDatasetBase);
    const docker = new DockerManager();

    // Detect orphans
    const result = await detectOrphans(stateData, zfs, docker);

    // Should find both orphans
    expect(result.datasets.length).toBeGreaterThanOrEqual(1);
    expect(result.containers.length).toBeGreaterThanOrEqual(1);
    expect(result.totalOrphans).toBeGreaterThanOrEqual(2);

    const foundDataset = result.datasets.find(d => d.name === orphanDatasetName);
    const foundContainer = result.containers.find(c => c.name === orphanContainerName);
    expect(foundDataset).toBeDefined();
    expect(foundContainer).toBeDefined();

    // Cleanup orphans
    await $`sudo zfs destroy ${fullPath}`.quiet();
    await $`docker rm -f ${orphanContainerName}`.quiet();
  }, { timeout: 30000 });

  test('should not detect base dataset as orphan', async () => {
    // Get state config
    const state = new StateManager(PATHS.STATE);
    await state.load();
    const stateData = state.getState();

    // Initialize managers
    const zfs = new ZFSManager(stateData.zfsPool, stateData.zfsDatasetBase);
    const docker = new DockerManager();

    // Detect orphans
    const result = await detectOrphans(stateData, zfs, docker);

    // Should not detect the base dataset as orphan
    const baseDatasetOrphan = result.datasets.find(
      d => d.fullPath === `${stateData.zfsPool}/${stateData.zfsDatasetBase}`
    );
    expect(baseDatasetOrphan).toBeUndefined();
  }, { timeout: 30000 });

  test('should calculate total wasted bytes correctly', async () => {
    // Get state config
    const state = new StateManager(PATHS.STATE);
    await state.load();
    const stateData = state.getState();

    // Create orphaned dataset
    const orphanDatasetName = 'waste-calc-test';
    const fullPath = `${stateData.zfsPool}/${stateData.zfsDatasetBase}/${orphanDatasetName}`;
    await $`sudo zfs create ${fullPath}`.quiet();

    // Initialize managers
    const zfs = new ZFSManager(stateData.zfsPool, stateData.zfsDatasetBase);
    const docker = new DockerManager();

    // Detect orphans
    const result = await detectOrphans(stateData, zfs, docker);

    // Should calculate total bytes
    if (result.datasets.length > 0) {
      expect(result.totalWastedBytes).toBeGreaterThan(0);
      const sumBytes = result.datasets.reduce((sum, d) => sum + d.sizeBytes, 0);
      expect(result.totalWastedBytes).toBe(sumBytes);
    }

    // Cleanup orphan
    await $`sudo zfs destroy ${fullPath}`.quiet();
  }, { timeout: 30000 });

  test('formatBytes should format bytes correctly', () => {
    expect(formatBytes(0)).toBe('0.00 B');
    expect(formatBytes(500)).toBe('500.00 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
    expect(formatBytes(1536)).toBe('1.50 KB'); // 1.5 KB
    expect(formatBytes(1024 * 1024 * 1.5)).toBe('1.50 MB');
  });
});
