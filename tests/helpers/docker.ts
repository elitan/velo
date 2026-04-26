/**
 * Docker container utilities
 */

import { spawn } from 'bun';
import { CONTAINER_PREFIX } from '../../src/config/constants';

/**
 * Check if container is running
 */
export async function isContainerRunning(name: string): Promise<boolean> {
  const fullName = name.startsWith(CONTAINER_PREFIX) ? name : `${CONTAINER_PREFIX}-${name}`;

  const proc = spawn(['docker', 'ps'], {
    stdout: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  return stdout.includes(fullName);
}

/**
 * Check if container exists but is stopped
 */
export async function isContainerStopped(name: string): Promise<boolean> {
  const fullName = name.startsWith(CONTAINER_PREFIX) ? name : `${CONTAINER_PREFIX}-${name}`;

  const proc = spawn(['docker', 'ps', '-a'], {
    stdout: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const lines = stdout.split('\n');
  for (const line of lines) {
    if (line.includes(fullName) && line.includes('Exited')) {
      return true;
    }
  }

  return false;
}

/**
 * Check if container exists (running or stopped)
 */
export async function containerExists(name: string): Promise<boolean> {
  const fullName = name.startsWith(CONTAINER_PREFIX) ? name : `${CONTAINER_PREFIX}-${name}`;

  const proc = spawn(['docker', 'ps', '-a'], {
    stdout: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  return stdout.includes(fullName);
}

/**
 * Get container name for a project/branch
 */
export function getContainerName(project: string, branch: string): string {
  return `${CONTAINER_PREFIX}-${project}.${branch}`;
}
