import chalk from 'chalk';
import { StateManager } from '../../managers/state';
import { WALManager } from '../../managers/wal';
import { PATHS } from '../../utils/paths';
import { parseNamespace } from '../../utils/namespace';
import { formatRelativeTime } from '../../utils/time';
import { getDatasetName } from '../../utils/naming';
import { UserError } from '../../errors';
import { CLI_NAME } from '../../config/constants';

export async function walInfoCommand(branchName?: string) {
  const state = new StateManager(PATHS.STATE);
  await state.load();

  const wal = new WALManager();

  console.log();
  console.log(chalk.bold('WAL Archive Status'));
  console.log();

  if (branchName) {
    // Show info for specific branch
    const target = parseNamespace(branchName);
    const proj = state.projects.getByName(target.project);
    if (!proj) {
      throw new UserError(
        `Project '${target.project}' not found`,
        `Run '${CLI_NAME} project list' to see available projects`
      );
    }

    const branch = proj.branches.find(b => b.name === target.full);
    if (!branch) {
      throw new UserError(
        `Branch '${target.full}' not found`,
        `Run '${CLI_NAME} branch list' to see available branches`
      );
    }

    const datasetName = getDatasetName(target.project, target.branch);
    const info = await wal.getArchiveInfo(datasetName);

    console.log(chalk.bold(`Branch: ${target.full}`));
    console.log();
    console.log(chalk.dim('Archive path:  '), info.path);
    console.log(chalk.dim('File count:    '), info.fileCount);
    console.log(chalk.dim('Total size:    '), formatSize(info.sizeBytes));

    if (info.oldestWAL && info.oldestTimestamp) {
      console.log(chalk.dim('Oldest WAL:    '), info.oldestWAL);
      console.log(chalk.dim('               '), formatRelativeTime(info.oldestTimestamp));
    }

    if (info.newestWAL && info.newestTimestamp) {
      console.log(chalk.dim('Newest WAL:    '), info.newestWAL);
      console.log(chalk.dim('               '), formatRelativeTime(info.newestTimestamp));
    }

    console.log();

    // Check integrity
    const integrity = await wal.verifyArchiveIntegrity(datasetName);
    if (integrity.valid) {
      console.log('✓ No gaps detected in WAL archive');
    } else {
      console.log('⚠ Gaps detected in WAL archive:');
      for (const gap of integrity.gaps) {
        console.log(chalk.dim('  -'), gap);
      }
    }
    console.log();
  } else {
    // Show info for all projects
    const projects = state.getState().projects || [];

    if (projects.length === 0) {
      console.log(chalk.dim('No projects found'));
      console.log();
      return;
    }

    for (const proj of projects) {
      console.log(chalk.bold(proj.name));

      for (const branch of proj.branches) {
        const namespace = parseNamespace(branch.name);
        const datasetName = getDatasetName(namespace.project, namespace.branch);
        const info = await wal.getArchiveInfo(datasetName);

        console.log(chalk.dim(`  ${branch.name}`));
        console.log(chalk.dim(`    Files: ${info.fileCount} | Size: ${formatSize(info.sizeBytes)}`));

        if (info.oldestTimestamp && info.newestTimestamp) {
          const coverage = formatRelativeTime(info.oldestTimestamp) + ' to ' + formatRelativeTime(info.newestTimestamp);
          console.log(chalk.dim(`    Coverage: ${coverage}`));
        }
      }

      console.log();
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);

  return `${size.toFixed(2)} ${units[i]}`;
}
