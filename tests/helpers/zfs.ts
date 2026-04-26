/**
 * ZFS utilities
 */

import { $ } from 'bun';
import { getState } from './database';

/**
 * Get ZFS pool and dataset base
 */
export async function getZfsConfig(): Promise<{ pool: string; datasetBase: string }> {
  try {
    const state = await getState();
    return {
      pool: state.zfsPool || 'tank',
      datasetBase: state.zfsDatasetBase || 'velo/databases',
    };
  } catch {
    return {
      pool: 'tank',
      datasetBase: 'velo/databases',
    };
  }
}

/**
 * Check if ZFS dataset exists
 */
export async function datasetExists(name: string): Promise<boolean> {
  const { pool, datasetBase } = await getZfsConfig();
  const fullPath = `${pool}/${datasetBase}/${name}`;

  try {
    const result = await $`sudo zfs list ${fullPath}`.quiet();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Check if ZFS snapshot exists
 */
export async function snapshotExists(datasetName: string, snapshotName: string): Promise<boolean> {
  const { pool, datasetBase } = await getZfsConfig();
  const fullPath = `${pool}/${datasetBase}/${datasetName}@${snapshotName}`;

  const result = await $`sudo zfs list -t snapshot ${fullPath}`.quiet();
  return result.exitCode === 0;
}

/**
 * Get dataset size in bytes
 */
export async function getDatasetSize(name: string): Promise<number> {
  const { pool, datasetBase } = await getZfsConfig();
  const fullPath = `${pool}/${datasetBase}/${name}`;

  const result = await $`sudo zfs get -H -p -o value used ${fullPath}`.text();
  return parseInt(result.trim());
}

/**
 * List snapshots for a dataset
 */
export async function listSnapshots(datasetName: string): Promise<string[]> {
  const { pool, datasetBase } = await getZfsConfig();
  const fullPath = `${pool}/${datasetBase}/${datasetName}`;

  const result = await $`sudo zfs list -t snapshot -H -o name ${fullPath}`.quiet();

  if (result.exitCode !== 0) {
    return [];
  }

  const output = await result.text();
  return output
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      const parts = line.split('@');
      return parts[1] || '';
    })
    .filter(Boolean);
}

/**
 * Get ZFS dataset name for a branch
 */
export function getDatasetName(project: string, branch: string): string {
  return `${project}.${branch}`;
}
