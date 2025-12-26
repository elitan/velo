import Table from 'cli-table3';
import chalk from 'chalk';
import { format } from 'date-fns';
import { DockerManager } from '../managers/docker';
import { StateManager } from '../managers/state';
import { ZFSManager } from '../managers/zfs';
import { formatBytes } from '../utils/helpers';
import { PATHS } from '../utils/paths';
import { TOOL_NAME } from '../config/constants';
import { getContainerName, getDatasetName } from '../utils/naming';
import { parseNamespace } from '../utils/namespace';

function formatUptime(startedAt: Date | null): string {
  if (!startedAt) return 'N/A';

  const now = Date.now();
  const uptime = now - startedAt.getTime();

  const seconds = Math.floor(uptime / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatDate(dateStr: string): string {
  return format(new Date(dateStr), 'yyyy-MM-dd HH:mm:ss');
}

export async function statusCommand() {
  console.log();
  console.log(chalk.bold(`${TOOL_NAME} Status`));
  console.log();

  const state = new StateManager(PATHS.STATE);
  await state.load();

  // Get ZFS config from state
  const stateData = state.getState();

  const docker = new DockerManager();
  const zfs = new ZFSManager(stateData.zfsPool, stateData.zfsDatasetBase);

  // Get pool status
  const poolStatus = await zfs.getPoolStatus();

  const poolTable = new Table({
    head: ['Pool', 'Health', 'Size', 'Used', 'Free'],
    style: {
      head: [],
      border: ['gray']
    }
  });

  const usagePercent = ((poolStatus.allocated / poolStatus.size) * 100).toFixed(1);

  poolTable.push([
    chalk.bold(poolStatus.name),
    poolStatus.health,
    formatBytes(poolStatus.size),
    `${formatBytes(poolStatus.allocated)} ${chalk.dim(`(${usagePercent}%)`)}`,
    formatBytes(poolStatus.free)
  ]);

  console.log(chalk.bold('ZFS Pool'));
  console.log(poolTable.toString());
  console.log();

  // Get all projects
  const projects = state.projects.list();

  if (projects.length === 0) {
    console.log(chalk.dim('No projects found.'));
    return;
  }

  console.log(chalk.bold(`Projects (${projects.length})`));
  console.log();

  // Create table for all instances (primaries + branches)
  const instanceTable = new Table({
    head: ['', 'Name', 'Type', 'Image', 'Branches', 'Created'],
    style: {
      head: [],
      border: ['gray']
    }
  });

  for (const proj of projects) {
    // Project row - only show project-level info
    instanceTable.push([
      '●',
      chalk.bold(proj.name),
      'project',
      chalk.dim(proj.dockerImage),
      proj.branches.length.toString(),
      formatDate(proj.createdAt)
    ]);

    // Add branches
    for (const branch of proj.branches) {
      // Get branch container status
      const namespace = parseNamespace(branch.name);
      const containerName = getContainerName(namespace.project, namespace.branch);
      let branchContainerStatus = null;
      const branchContainerID = await docker.getContainerByName(containerName);
      if (branchContainerID) {
        try {
          branchContainerStatus = await docker.getContainerStatus(branchContainerID);
        } catch {
          // Container doesn't exist
        }
      }

      const actualBranchStatus = branchContainerStatus ? branchContainerStatus.state : branch.status;
      const branchStatusIcon = actualBranchStatus === 'running' ? '●' : '○';
      const branchStatusText = actualBranchStatus === 'running' ? 'running' : actualBranchStatus;
      const branchUptime = branchContainerStatus?.state === 'running' && branchContainerStatus.startedAt
        ? formatUptime(branchContainerStatus.startedAt)
        : chalk.dim('—');

      // Query size on-demand from ZFS
      const datasetName = getDatasetName(namespace.project, namespace.branch);
      let sizeBytes = 0;
      try {
        sizeBytes = await zfs.getUsedSpace(datasetName);
      } catch {
        // If dataset doesn't exist, show 0
      }

      // Branch row with different columns
      instanceTable.push([
        branchStatusIcon,
        chalk.dim('  ↳ ') + branch.name,
        `${branchStatusText} | ${branchUptime}`,
        `Port ${branch.port}`,
        formatBytes(sizeBytes),
        formatDate(branch.createdAt)
      ]);
    }
  }

  console.log(instanceTable.toString());
  console.log();
}
