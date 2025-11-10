import chalk from 'chalk';
import { $ } from 'bun';
import { StateManager } from '../managers/state';
import { DockerManager } from '../managers/docker';
import { ZFSManager } from '../managers/zfs';
import { PATHS } from '../utils/paths';
import { DEFAULTS } from '../config/defaults';
import { getZFSPool } from '../utils/zfs-pool';
import { validateAllPermissions } from '../utils/zfs-permissions';
import * as fs from 'fs/promises';
import { CLI_NAME } from '../config/constants';
import { detectOrphans } from '../utils/orphan-detection';
import { formatBytes } from '../utils/helpers';

interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'info';
  message: string;
  details?: string[];
}

export async function doctorCommand() {
  console.log();
  console.log(chalk.bold(`${CLI_NAME} Health Check`));
  console.log(chalk.dim('═'.repeat(60)));
  console.log();

  const allResults: CheckResult[] = [];

  // System Information
  console.log(chalk.bold('System Information'));
  console.log(chalk.dim('─'.repeat(60)));

  const systemResults = [
    await checkOS(),
    await checkBunVersion(),
    await checkPgdVersion(),
  ];
  allResults.push(...systemResults);
  printResults(systemResults);
  console.log();

  // ZFS Checks
  console.log(chalk.bold('ZFS Configuration'));
  console.log(chalk.dim('─'.repeat(60)));

  const zfsResults = [
    await checkZFSInstalled(),
    await checkZFSPool(),
    await checkZFSPermissions(),
    await checkZFSDataset(),
  ];
  allResults.push(...zfsResults);
  printResults(zfsResults);
  console.log();

  // Docker Checks
  console.log(chalk.bold('Docker Configuration'));
  console.log(chalk.dim('─'.repeat(60)));

  const dockerResults = [
    await checkDockerInstalled(),
    await checkDockerRunning(),
    await checkDockerPermissions(),
    await checkVeloGroup(),
    await checkDockerImages(),
  ];
  allResults.push(...dockerResults);
  printResults(dockerResults);
  console.log();

  // State
  console.log(chalk.bold(`${CLI_NAME} State`));
  console.log(chalk.dim('─'.repeat(60)));

  const stateResults = [
    await checkStateFile(),
    await checkWALDirectory(),
    await checkProjects(),
    await checkContainers(),
  ];
  allResults.push(...stateResults);
  printResults(stateResults);
  console.log();

  // File Permissions
  console.log(chalk.bold('File Permissions'));
  console.log(chalk.dim('─'.repeat(60)));

  const permResults = [
    await checkStateFilePermissions(),
    await checkWALPermissions(),
  ];
  allResults.push(...permResults);
  printResults(permResults);
  console.log();

  // Orphaned Resources
  console.log(chalk.bold('Orphaned Resources'));
  console.log(chalk.dim('─'.repeat(60)));

  const orphanResults = [
    await checkOrphans(),
  ];
  allResults.push(...orphanResults);
  printResults(orphanResults);
  console.log();

  // Summary
  console.log(chalk.dim('═'.repeat(60)));
  printSummary(allResults);
}

function printResults(results: CheckResult[]) {
  for (const result of results) {
    const icon = result.status === 'pass' ? '✓'
      : result.status === 'fail' ? '✗'
      : result.status === 'warn' ? '⚠'
      : 'ℹ';

    console.log(`${icon} ${result.name}`);

    if (result.message) {
      console.log(`  ${chalk.dim(result.message)}`);
    }

    if (result.details && result.details.length > 0) {
      for (const detail of result.details) {
        console.log(`  ${chalk.dim('→')} ${chalk.dim(detail)}`);
      }
    }
  }
}

function printSummary(allResults: CheckResult[]) {
  const passed = allResults.filter(r => r.status === 'pass').length;
  const failed = allResults.filter(r => r.status === 'fail').length;
  const warnings = allResults.filter(r => r.status === 'warn').length;
  const info = allResults.filter(r => r.status === 'info').length;

  console.log();
  console.log(chalk.bold('Summary:'));
  console.log(`  ✓ Passed: ${passed}`);
  if (warnings > 0) console.log(`  ⚠ Warnings: ${warnings}`);
  if (failed > 0) console.log(`  ✗ Failed: ${failed}`);
  if (info > 0) console.log(`  ℹ Info: ${info}`);

  console.log();

  if (failed > 0) {
    console.log('✗ Issues detected. Please fix the failed checks above.');
    console.log();
    console.log('Common fixes:');
    console.log(`  • Run setup: ${CLI_NAME} setup`);
    console.log('  • Create ZFS pool: sudo zpool create tank /dev/sdb');
    console.log('  • Log out and back in (for group changes)');
  } else if (warnings > 0) {
    console.log(`⚠ ${CLI_NAME} is functional but has warnings. Review above.`);
  } else {
    console.log(`✓ All checks passed! ${CLI_NAME} is ready to use.`);
  }
  console.log();
}

// Check functions
async function checkOS(): Promise<CheckResult> {
  try {
    const result = await $`uname -s`.text();
    const os = result.trim();

    if (os === 'Linux') {
      const distro = await $`cat /etc/os-release | grep "^PRETTY_NAME=" | cut -d'"' -f2`.quiet().text();
      return {
        name: 'Operating System',
        status: 'pass',
        message: distro.trim(),
      };
    } else {
      return {
        name: 'Operating System',
        status: 'fail',
        message: `Detected ${os}. ${CLI_NAME} requires Linux.`,
      };
    }
  } catch (error) {
    return {
      name: 'Operating System',
      status: 'fail',
      message: 'Unable to detect OS',
    };
  }
}

async function checkBunVersion(): Promise<CheckResult> {
  try {
    const version = await $`bun --version`.text();
    return {
      name: 'Bun Runtime',
      status: 'pass',
      message: `v${version.trim()}`,
    };
  } catch (error) {
    return {
      name: 'Bun Runtime',
      status: 'fail',
      message: 'Bun not found. Install: curl -fsSL https://bun.sh/install | bash',
    };
  }
}

async function checkPgdVersion(): Promise<CheckResult> {
  try {
    const packageJson = await Bun.file('package.json').text();
    const pkg = JSON.parse(packageJson);
    return {
      name: `${CLI_NAME} Version`,
      status: 'info',
      message: `v${pkg.version}`,
    };
  } catch (error) {
    return {
      name: `${CLI_NAME} Version`,
      status: 'info',
      message: 'Unable to detect version',
    };
  }
}

async function checkZFSInstalled(): Promise<CheckResult> {
  try {
    const version = await $`zfs version`.quiet().text();
    const match = version.match(/zfs-(\S+)/);
    const versionStr = match ? match[1] : 'unknown';

    return {
      name: 'ZFS Installation',
      status: 'pass',
      message: `zfs-${versionStr}`,
    };
  } catch (error) {
    return {
      name: 'ZFS Installation',
      status: 'fail',
      message: 'ZFS not installed. Run: sudo apt install zfsutils-linux',
    };
  }
}

async function checkZFSPool(): Promise<CheckResult> {
  try {
    const pools = await $`zpool list -H -o name`.quiet().text();
    const poolList = pools.trim().split('\n').filter(p => p);

    if (poolList.length === 0) {
      return {
        name: 'ZFS Pool',
        status: 'fail',
        message: 'No ZFS pools found',
        details: [
          'Create a pool: sudo zpool create tank /dev/sdb',
          'For testing: sudo truncate -s 10G /tmp/zfs-pool.img && sudo zpool create tank /tmp/zfs-pool.img',
        ],
      };
    }

    // Try to get the pool from state
    let statePool: string | null = null;
    try {
      const state = new StateManager(PATHS.STATE);
      await state.load();
      if (state.isInitialized()) {
        const stateData = state.getState();
        statePool = stateData.zfsPool;
      }
    } catch (error) {
      // State not initialized yet, that's okay
    }

    if (statePool) {
      return {
        name: 'ZFS Pool',
        status: 'pass',
        message: `Using pool: ${statePool}`,
        details: poolList.length > 1 ? [`Other pools: ${poolList.filter(p => p !== statePool).join(', ')}`] : undefined,
      };
    } else if (poolList.length === 1) {
      return {
        name: 'ZFS Pool',
        status: 'pass',
        message: `Available pool: ${poolList[0]}`,
        details: ['Will be auto-detected on first project create'],
      };
    } else {
      return {
        name: 'ZFS Pool',
        status: 'warn',
        message: `Found ${poolList.length} pools: ${poolList.join(', ')}`,
        details: [`Specify pool when creating project: ${CLI_NAME} project create myapp ${chalk.bold('--pool')} <name>`],
      };
    }
  } catch (error) {
    return {
      name: 'ZFS Pool',
      status: 'fail',
      message: 'Unable to list ZFS pools',
    };
  }
}

async function checkZFSPermissions(): Promise<CheckResult> {
  try {
    // Get pool from state or auto-detect
    let pool: string;
    try {
      const state = new StateManager(PATHS.STATE);
      await state.load();
      if (state.isInitialized()) {
        const stateData = state.getState();
        pool = stateData.zfsPool;
      } else {
        pool = await getZFSPool();
      }
    } catch (error) {
      pool = await getZFSPool();
    }

    // Check if running as root (skip validation)
    if (process.getuid && process.getuid() === 0) {
      return {
        name: 'ZFS Permissions',
        status: 'warn',
        message: 'Running as root - permissions not validated',
      };
    }

    try {
      await validateAllPermissions(pool, DEFAULTS.zfs.datasetBase);
      return {
        name: 'ZFS Permissions',
        status: 'pass',
        message: `Delegation configured for ${pool}/${DEFAULTS.zfs.datasetBase}`,
      };
    } catch (error) {
      return {
        name: 'ZFS Permissions',
        status: 'fail',
        message: 'ZFS permissions not configured',
        details: [
          `Run setup: ${CLI_NAME} setup`,
          'This grants ZFS delegation permissions to your user',
        ],
      };
    }
  } catch (error) {
    return {
      name: 'ZFS Permissions',
      status: 'fail',
      message: 'Unable to check permissions',
    };
  }
}

async function checkZFSDataset(): Promise<CheckResult> {
  try {
    const state = new StateManager(PATHS.STATE);
    await state.load();

    if (!state.isInitialized()) {
      return {
        name: 'ZFS Dataset',
        status: 'info',
        message: 'Not initialized yet',
        details: ['Will be created on first project create'],
      };
    }

    const stateData = state.getState();
    const fullPath = `${stateData.zfsPool}/${stateData.zfsDatasetBase}`;

    try {
      const result = await $`zfs list -H -o name ${fullPath}`.quiet().text();
      if (result.trim() === fullPath) {
        return {
          name: 'ZFS Dataset',
          status: 'pass',
          message: fullPath,
        };
      }
    } catch (error) {
      return {
        name: 'ZFS Dataset',
        status: 'warn',
        message: `Dataset ${fullPath} not found`,
        details: ['Will be created automatically on next project create'],
      };
    }
  } catch (error) {
    return {
      name: 'ZFS Dataset',
      status: 'info',
      message: 'State not initialized',
    };
  }

  return {
    name: 'ZFS Dataset',
    status: 'info',
    message: 'Unknown',
  };
}

async function checkDockerInstalled(): Promise<CheckResult> {
  try {
    const version = await $`docker --version`.quiet().text();
    const match = version.match(/Docker version ([\d.]+)/);
    const versionStr = match ? match[1] : 'unknown';

    return {
      name: 'Docker Installation',
      status: 'pass',
      message: `v${versionStr}`,
    };
  } catch (error) {
    return {
      name: 'Docker Installation',
      status: 'fail',
      message: 'Docker not installed. Run: curl -fsSL https://get.docker.com | sh',
    };
  }
}

async function checkDockerRunning(): Promise<CheckResult> {
  try {
    await $`docker info`.quiet();
    return {
      name: 'Docker Daemon',
      status: 'pass',
      message: 'Running',
    };
  } catch (error) {
    return {
      name: 'Docker Daemon',
      status: 'fail',
      message: 'Docker daemon not running. Start: sudo systemctl start docker',
    };
  }
}

async function checkDockerPermissions(): Promise<CheckResult> {
  try {
    // Check if user is in docker group
    const groups = await $`groups`.text();
    const hasDockerGroup = groups.includes('docker');

    // Try to run docker command
    try {
      await $`docker ps`.quiet();
      return {
        name: 'Docker Permissions',
        status: 'pass',
        message: hasDockerGroup ? 'User in docker group' : 'Can access docker',
      };
    } catch (error) {
      if (!hasDockerGroup) {
        return {
          name: 'Docker Permissions',
          status: 'fail',
          message: 'Not in docker group',
          details: [
            'Add to group: sudo usermod -aG docker $USER',
            'Then log out and back in',
          ],
        };
      } else {
        return {
          name: 'Docker Permissions',
          status: 'fail',
          message: 'Cannot access Docker daemon',
          details: ['Try logging out and back in (group membership not active)'],
        };
      }
    }
  } catch (error) {
    return {
      name: 'Docker Permissions',
      status: 'fail',
      message: 'Unable to check permissions',
    };
  }
}

async function checkVeloGroup(): Promise<CheckResult> {
  try {
    // Skip check if running as root
    if (process.getuid && process.getuid() === 0) {
      return {
        name: `${CLI_NAME} Group`,
        status: 'warn',
        message: 'Running as root - group check skipped',
      };
    }

    const groups = await $`groups`.text();
    const hasVeloGroup = groups.includes(CLI_NAME);

    if (hasVeloGroup) {
      return {
        name: `${CLI_NAME} Group`,
        status: 'pass',
        message: `User in ${CLI_NAME} group`,
      };
    } else {
      return {
        name: `${CLI_NAME} Group`,
        status: 'fail',
        message: `Not in ${CLI_NAME} group`,
        details: [
          `Run setup: ${CLI_NAME} setup`,
          'Then log out and back in',
        ],
      };
    }
  } catch (error) {
    return {
      name: `${CLI_NAME} Group`,
      status: 'fail',
      message: 'Unable to check group membership',
    };
  }
}

async function checkDockerImages(): Promise<CheckResult> {
  try {
    const docker = new DockerManager();
    const defaultImageExists = await docker.imageExists(DEFAULTS.postgres.defaultImage);

    if (defaultImageExists) {
      return {
        name: 'Docker Images',
        status: 'pass',
        message: `Default image cached: ${DEFAULTS.postgres.defaultImage}`,
      };
    } else {
      return {
        name: 'Docker Images',
        status: 'info',
        message: 'Default image not cached',
        details: ['Will be pulled automatically on first project create'],
      };
    }
  } catch (error) {
    return {
      name: 'Docker Images',
      status: 'warn',
      message: 'Unable to check images',
    };
  }
}

async function checkStateFile(): Promise<CheckResult> {
  try {
    const exists = await Bun.file(PATHS.STATE).exists();

    if (!exists) {
      return {
        name: 'State File',
        status: 'info',
        message: 'Not initialized',
        details: ['Will be created on first project create'],
      };
    }

    const state = new StateManager(PATHS.STATE);
    await state.load();
    const stateData = state.getState();

    const projectCount = stateData.projects?.length || 0;
    const branchCount = stateData.projects?.reduce((sum, p) => sum + p.branches.length, 0) || 0;

    return {
      name: 'State File',
      status: 'pass',
      message: `${projectCount} project(s), ${branchCount} branch(es)`,
      details: [`Location: ${PATHS.STATE}`],
    };
  } catch (error) {
    return {
      name: 'State File',
      status: 'fail',
      message: 'State file corrupted or unreadable',
      details: [`Location: ${PATHS.STATE}`],
    };
  }
}

async function checkWALDirectory(): Promise<CheckResult> {
  try {
    const exists = await Bun.file(PATHS.WAL_ARCHIVE).exists();

    if (!exists) {
      return {
        name: 'WAL Archive Directory',
        status: 'info',
        message: 'Not created yet',
        details: ['Will be created on first project create'],
      };
    }

    const entries = await fs.readdir(PATHS.WAL_ARCHIVE);
    const datasetDirs = entries.filter(e => !e.startsWith('.'));

    return {
      name: 'WAL Archive Directory',
      status: 'pass',
      message: `${datasetDirs.length} dataset(s)`,
      details: [`Location: ${PATHS.WAL_ARCHIVE}`],
    };
  } catch (error) {
    return {
      name: 'WAL Archive Directory',
      status: 'warn',
      message: 'Unable to check directory',
    };
  }
}

async function checkProjects(): Promise<CheckResult> {
  try {
    const state = new StateManager(PATHS.STATE);
    await state.load();

    if (!state.isInitialized()) {
      return {
        name: 'Projects',
        status: 'info',
        message: 'No projects yet',
        details: [`Create first project: ${CLI_NAME} project create myapp`],
      };
    }

    const stateData = state.getState();
    const projects = stateData.projects || [];

    if (projects.length === 0) {
      return {
        name: 'Projects',
        status: 'info',
        message: 'No projects',
        details: [`Create first project: ${CLI_NAME} project create myapp`],
      };
    }

    const details = projects.map(p => {
      const branchCount = p.branches.length;
      return `${p.name}: ${branchCount} branch(es), ${p.dockerImage}`;
    });

    return {
      name: 'Projects',
      status: 'pass',
      message: `${projects.length} project(s)`,
      details,
    };
  } catch (error) {
    return {
      name: 'Projects',
      status: 'info',
      message: 'No projects',
    };
  }
}

async function checkContainers(): Promise<CheckResult> {
  try {
    const docker = new DockerManager();
    const allContainers = await docker.listContainers();
    const cliContainers = allContainers.filter(c => c.name.startsWith(`${CLI_NAME}-`));

    if (cliContainers.length === 0) {
      return {
        name: 'Docker Containers',
        status: 'info',
        message: `No ${CLI_NAME} containers`,
      };
    }

    const running = cliContainers.filter(c => c.state === 'running').length;
    const stopped = cliContainers.length - running;

    const details = cliContainers.map(c => {
      const name = c.name.replace(`${CLI_NAME}-`, '');
      const stateIcon = c.state === 'running' ? '●' : '○';
      return `${stateIcon} ${name} (${c.state})`;
    });

    return {
      name: 'Docker Containers',
      status: 'pass',
      message: `${running} running, ${stopped} stopped`,
      details,
    };
  } catch (error) {
    return {
      name: 'Docker Containers',
      status: 'warn',
      message: 'Unable to list containers',
    };
  }
}

async function checkStateFilePermissions(): Promise<CheckResult> {
  try {
    const exists = await Bun.file(PATHS.STATE).exists();
    if (!exists) {
      return {
        name: 'State File Permissions',
        status: 'info',
        message: 'State file not created yet',
      };
    }

    const stat = await fs.stat(PATHS.STATE);
    const uid = process.getuid ? process.getuid() : -1;

    if (stat.uid === uid) {
      return {
        name: 'State File Permissions',
        status: 'pass',
        message: 'Owned by current user',
      };
    } else {
      return {
        name: 'State File Permissions',
        status: 'warn',
        message: 'Not owned by current user',
        details: [`File is owned by UID ${stat.uid}, you are UID ${uid}`],
      };
    }
  } catch (error) {
    return {
      name: 'State File Permissions',
      status: 'warn',
      message: 'Unable to check permissions',
    };
  }
}

async function checkWALPermissions(): Promise<CheckResult> {
  try {
    const exists = await Bun.file(PATHS.WAL_ARCHIVE).exists();
    if (!exists) {
      return {
        name: 'WAL Directory Permissions',
        status: 'info',
        message: 'WAL directory not created yet',
      };
    }

    const stat = await fs.stat(PATHS.WAL_ARCHIVE);
    const uid = process.getuid ? process.getuid() : -1;

    if (stat.uid === uid) {
      return {
        name: 'WAL Directory Permissions',
        status: 'pass',
        message: 'Owned by current user',
      };
    } else {
      return {
        name: 'WAL Directory Permissions',
        status: 'warn',
        message: 'Not owned by current user',
        details: [`Directory is owned by UID ${stat.uid}, you are UID ${uid}`],
      };
    }
  } catch (error) {
    return {
      name: 'WAL Directory Permissions',
      status: 'warn',
      message: 'Unable to check permissions',
    };
  }
}

async function checkOrphans(): Promise<CheckResult> {
  try {
    const state = new StateManager(PATHS.STATE);
    await state.load();

    if (!state.isInitialized()) {
      return {
        name: 'Orphaned Resources',
        status: 'info',
        message: 'Not initialized yet',
      };
    }

    const stateData = state.getState();
    const zfs = new ZFSManager(stateData.zfsPool, stateData.zfsDatasetBase);
    const docker = new DockerManager();

    const result = await detectOrphans(stateData, zfs, docker);

    if (result.totalOrphans === 0) {
      return {
        name: 'Orphaned Resources',
        status: 'pass',
        message: 'No orphaned resources found',
      };
    }

    const details: string[] = [];

    if (result.datasets.length > 0) {
      details.push(`ZFS datasets: ${result.datasets.length} orphaned`);
      for (const dataset of result.datasets) {
        details.push(`  • ${dataset.name} (${formatBytes(dataset.sizeBytes)})`);
      }
    }

    if (result.containers.length > 0) {
      details.push(`Docker containers: ${result.containers.length} orphaned`);
      for (const container of result.containers) {
        details.push(`  • ${container.name} (${container.state})`);
      }
    }

    details.push('');
    details.push(`Total wasted disk space: ${formatBytes(result.totalWastedBytes)}`);
    details.push(`Run 'velo cleanup' to remove orphaned resources`);

    return {
      name: 'Orphaned Resources',
      status: 'warn',
      message: `Found ${result.totalOrphans} orphaned resource(s)`,
      details,
    };
  } catch (error) {
    return {
      name: 'Orphaned Resources',
      status: 'warn',
      message: 'Unable to check for orphans',
    };
  }
}
