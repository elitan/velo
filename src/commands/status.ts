import Table from 'cli-table3';
import chalk from 'chalk';
import { format } from 'date-fns';
import { formatBytes } from '../utils/helpers';
import { TOOL_NAME } from '../config/constants';
import { initializeServices } from '../utils/service-factory';
import { getBranchHealth, type BranchHealth } from '../services/branch-health-service';

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

  const { state, zfs, docker, wal } = await initializeServices();

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
    head: ['', 'Name', 'State', 'Health', 'Lifecycle', 'Image / Port', 'Branches / Size', 'Created'],
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
      chalk.dim('—'),
      chalk.dim('—'),
      chalk.dim(proj.dockerImage),
      proj.branches.length.toString(),
      formatDate(proj.createdAt)
    ]);

    // Add branches
    for (const branch of proj.branches) {
      const health = await getBranchHealth(branch, { zfs, docker, wal });
      const branchStatusIcon = getHealthIcon(health);
      const observedText = health.observedStatus === 'running' && health.startedAt
        ? `running ${formatUptime(health.startedAt)}`
        : health.observedStatus;
      const portText = health.port ?? branch.port;
      const sizeText = health.sizeBytes === null
        ? chalk.dim(health.reason === 'DatasetMissing' ? 'missing' : 'unknown')
        : formatBytes(health.sizeBytes);
      const healthText = formatHealth(health);
      const stateText = `${branch.status} | ${observedText}`;

      instanceTable.push([
        branchStatusIcon,
        chalk.dim('  ↳ ') + branch.name,
        stateText,
        healthText,
        formatLifecycle(branch.idleStop),
        portText ? `Port ${portText}` : chalk.dim('missing'),
        sizeText,
        formatDate(branch.createdAt)
      ]);
    }
  }

  console.log(instanceTable.toString());
  console.log();
}

function getHealthIcon(health: BranchHealth): string {
  if (health.status === 'healthy') {
    return health.observedStatus === 'running' ? '●' : '○';
  }

  return health.status === 'critical' ? '✗' : '!';
}

function formatHealth(health: BranchHealth): string {
  if (health.reason === 'Healthy') {
    return chalk.green('Healthy');
  }

  if (health.status === 'critical') {
    return chalk.red(health.reason);
  }

  return chalk.yellow(health.reason);
}

function formatLifecycle(idleStop: { enabled: boolean; idleMinutes: number; stoppedReason?: string } | undefined): string {
  if (!idleStop?.enabled) {
    return chalk.dim('—');
  }

  if (idleStop.stoppedReason) {
    return `idle-stop ${idleStop.idleMinutes}m (${idleStop.stoppedReason})`;
  }

  return `idle-stop ${idleStop.idleMinutes}m`;
}
