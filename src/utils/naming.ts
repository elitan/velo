import { CONTAINER_PREFIX } from '../config/constants';
import type { Branch } from '../types/state';
import { parseNamespace } from './namespace';

function getResourceName(projectName: string, branchName: string): string {
  return `${projectName}.${branchName}`;
}

function getLegacyResourceName(projectName: string, branchName: string): string {
  return `${projectName}-${branchName}`;
}

export function getContainerName(projectName: string, branchName: string): string {
  return `${CONTAINER_PREFIX}-${getResourceName(projectName, branchName)}`;
}

export function getLegacyContainerName(projectName: string, branchName: string): string {
  return `${CONTAINER_PREFIX}-${getLegacyResourceName(projectName, branchName)}`;
}

export function getBranchContainerName(branch: Branch): string {
  if (branch.containerName) {
    return branch.containerName;
  }

  const namespace = parseNamespace(branch.name);
  return getLegacyContainerName(namespace.project, namespace.branch);
}

export function getDatasetName(projectName: string, branchName: string): string {
  return getResourceName(projectName, branchName);
}

export function getDatasetPathFromName(pool: string, datasetBase: string, datasetName: string): string {
  return `${pool}/${datasetBase}/${datasetName}`;
}

export function getDatasetPath(pool: string, datasetBase: string, projectName: string, branchName: string): string {
  const datasetName = getDatasetName(projectName, branchName);
  return getDatasetPathFromName(pool, datasetBase, datasetName);
}
