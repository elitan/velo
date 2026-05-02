import { CONTAINER_PREFIX } from '../config/constants';

function getResourceName(projectName: string, branchName: string): string {
  return `${projectName}.${branchName}`;
}

export function getContainerName(projectName: string, branchName: string): string {
  return `${CONTAINER_PREFIX}-${getResourceName(projectName, branchName)}`;
}

export function getDatasetName(projectName: string, branchName: string): string {
  return getResourceName(projectName, branchName);
}
