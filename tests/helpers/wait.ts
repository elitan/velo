/**
 * Smart wait strategies for test resources
 * Replaces hardcoded Bun.sleep() calls with polling-based waits
 */

import { getContainerName, isContainerRunning, isContainerStopped } from './docker';
import { datasetExists, getDatasetName } from './zfs';
import { getBranchPort, getProjectCredentials, waitForReady as waitForPostgresReady } from './database';

/**
 * Timeout constants for different operations
 */
export const TIMEOUTS = {
  CONTAINER_START: 30_000,
  CONTAINER_STOP: 10_000,
  DATASET_CREATE: 5_000,
  POSTGRES_READY: 60_000,
  PITR_RECOVERY: 180_000, // PITR recovery needs extra time for WAL replay
} as const;

/**
 * Poll interval for all wait operations
 */
const POLL_INTERVAL = 500;

/**
 * Low-level wait primitives
 */

/**
 * Wait for Docker container to be running
 */
export async function waitForContainer(
  name: string,
  timeoutMs = TIMEOUTS.CONTAINER_START
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (await isContainerRunning(name)) {
      return;
    }
    await Bun.sleep(POLL_INTERVAL);
  }

  throw new Error(`Container ${name} did not start within ${timeoutMs}ms`);
}

/**
 * Wait for Docker container to be stopped
 */
export async function waitForContainerStopped(
  name: string,
  timeoutMs = TIMEOUTS.CONTAINER_STOP
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const running = await isContainerRunning(name);
    if (!running) {
      return;
    }
    await Bun.sleep(POLL_INTERVAL);
  }

  throw new Error(`Container ${name} did not stop within ${timeoutMs}ms`);
}

/**
 * Wait for ZFS dataset to exist
 */
export async function waitForDataset(
  name: string,
  timeoutMs = TIMEOUTS.DATASET_CREATE
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (await datasetExists(name)) {
      return;
    }
    await Bun.sleep(POLL_INTERVAL);
  }

  throw new Error(`Dataset ${name} not created within ${timeoutMs}ms`);
}

/**
 * High-level orchestrators
 */

/**
 * Wait for PostgreSQL branch to be fully ready
 * - Dataset exists
 * - Container running
 * - PostgreSQL accepting connections
 */
export async function waitForBranchReady(
  projectName: string,
  branchName: string,
  timeoutMs = TIMEOUTS.POSTGRES_READY
): Promise<void> {
  const datasetName = getDatasetName(projectName, branchName);
  const containerName = getContainerName(projectName, branchName);
  const fullBranchName = `${projectName}/${branchName}`;

  // Wait for dataset
  await waitForDataset(datasetName);

  // Wait for container
  await waitForContainer(containerName);

  // Wait for PostgreSQL
  const port = await getBranchPort(fullBranchName);
  const creds = await getProjectCredentials(projectName);
  await waitForPostgresReady(port, creds.password, timeoutMs);
}

/**
 * Wait for project (main branch) to be fully ready
 * Convenience wrapper around waitForBranchReady
 */
export async function waitForProjectReady(
  projectName: string,
  timeoutMs = TIMEOUTS.POSTGRES_READY
): Promise<void> {
  await waitForBranchReady(projectName, 'main', timeoutMs);
}
