/**
 * Orphan detection utilities
 *
 * Detects ZFS datasets and Docker containers that exist but are not tracked in state.
 */

import { ZFSManager } from '../managers/zfs';
import { DockerManager } from '../managers/docker';
import type { State, Branch } from '../types/state';
import { CONTAINER_PREFIX } from '../config/constants';
import { getContainerName } from './naming';
import { parseNamespace } from './namespace';

export interface OrphanedDataset {
  name: string;           // Simple dataset name (e.g., "api-dev")
  fullPath: string;       // Full ZFS path (e.g., "tank/velo/databases/api-dev")
  sizeBytes: number;      // Size in bytes
  createdAt: Date;        // Creation timestamp
}

export interface OrphanedContainer {
  name: string;           // Container name (e.g., "velo-api-dev")
  id: string;             // Docker container ID
  state: string;          // Container state (running, stopped, etc.)
  createdAt: Date;        // Creation timestamp
}

export interface OrphanDetectionResult {
  datasets: OrphanedDataset[];
  containers: OrphanedContainer[];
  totalOrphans: number;
  totalWastedBytes: number;
}

/**
 * Extract simple dataset name from full ZFS path
 * Example: "tank/velo/databases/api-dev" → "api-dev"
 */
function extractDatasetName(fullPath: string, pool: string, datasetBase: string): string | null {
  const prefix = `${pool}/${datasetBase}/`;
  if (!fullPath.startsWith(prefix)) {
    return null;
  }
  return fullPath.substring(prefix.length);
}

/**
 * Detect orphaned ZFS datasets and Docker containers
 */
export async function detectOrphans(
  state: State,
  zfs: ZFSManager,
  docker: DockerManager
): Promise<OrphanDetectionResult> {
  const orphanedDatasets: OrphanedDataset[] = [];
  const orphanedContainers: OrphanedContainer[] = [];

  // Get expected resources from state
  const expectedDatasets = new Set<string>();
  const expectedContainers = new Set<string>();

  for (const project of state.projects) {
    for (const branch of project.branches) {
      // Extract simple branch name from namespaced name (e.g., "api/dev" → "dev")
      const parsed = parseNamespace(branch.name);
      if (!parsed) continue;

      // Add expected dataset
      expectedDatasets.add(branch.zfsDataset);

      // Add expected container
      const containerName = getContainerName(parsed.project, parsed.branch);
      expectedContainers.add(containerName);
    }
  }

  // Find orphaned ZFS datasets
  const actualDatasets = await zfs.listDatasets();
  for (const dataset of actualDatasets) {
    // Skip non-filesystem types (snapshots, volumes, etc.)
    if (dataset.type !== 'filesystem') {
      continue;
    }

    // Extract simple dataset name
    const simpleName = extractDatasetName(dataset.name, state.zfsPool, state.zfsDatasetBase);

    // Skip the base dataset itself
    if (simpleName === null || simpleName === '' || dataset.name === `${state.zfsPool}/${state.zfsDatasetBase}`) {
      continue;
    }

    // Check if orphaned
    if (!expectedDatasets.has(simpleName)) {
      orphanedDatasets.push({
        name: simpleName,
        fullPath: dataset.name,
        sizeBytes: dataset.used,
        createdAt: dataset.created,
      });
    }
  }

  // Find orphaned Docker containers
  const actualContainers = await docker.listContainers();
  for (const container of actualContainers) {
    // Only check velo-prefixed containers
    if (!container.name.startsWith(CONTAINER_PREFIX)) {
      continue;
    }

    // Check if orphaned
    if (!expectedContainers.has(container.name)) {
      orphanedContainers.push({
        name: container.name,
        id: container.id,
        state: container.state,
        createdAt: container.startedAt || new Date(0),
      });
    }
  }

  // Calculate totals
  const totalWastedBytes = orphanedDatasets.reduce((sum, d) => sum + d.sizeBytes, 0);

  return {
    datasets: orphanedDatasets,
    containers: orphanedContainers,
    totalOrphans: orphanedDatasets.length + orphanedContainers.length,
    totalWastedBytes,
  };
}
