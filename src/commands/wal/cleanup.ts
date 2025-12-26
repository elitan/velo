import chalk from 'chalk';
import { StateManager } from '../../managers/state';
import { WALManager } from '../../managers/wal';
import { PATHS } from '../../utils/paths';
import { parseNamespace } from '../../utils/namespace';
import { getDatasetName } from '../../utils/naming';
import { UserError } from '../../errors';
import { withProgress } from '../../utils/progress';
import { CLI_NAME } from '../../config/constants';

export interface WALCleanupOptions {
  days?: number;
  dryRun?: boolean;
}

export async function walCleanupCommand(branchName: string, options: WALCleanupOptions = {}) {
  const retentionDays = options.days || 7; // Default to 7 days
  const dryRun = options.dryRun || false;

  const target = parseNamespace(branchName);
  const state = new StateManager(PATHS.STATE);
  await state.load();

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
  const wal = new WALManager();

  console.log();
  if (dryRun) {
    console.log(chalk.bold('WAL Cleanup (Dry Run)'));
  } else {
    console.log(chalk.bold('WAL Cleanup'));
  }
  console.log(chalk.dim(`Branch: ${target.full}`));
  console.log(chalk.dim(`Retention: ${retentionDays} days`));
  console.log();

  // Get archive info before cleanup
  const beforeInfo = await withProgress('Scan WAL archive', async () => {
    return await wal.getArchiveInfo(datasetName);
  });
  console.log(`Found ${beforeInfo.fileCount} WAL files`);

  if (beforeInfo.fileCount === 0) {
    console.log(chalk.dim('No WAL files to clean up'));
    console.log();
    return;
  }

  const beforeDate = new Date(Date.now() - (retentionDays * 24 * 60 * 60 * 1000));

  if (dryRun) {
    // Count how many files would be deleted
    let wouldDelete = 0;
    const info = await wal.getArchiveInfo(datasetName);

    if (info.oldestTimestamp && info.oldestTimestamp < beforeDate) {
      // Estimate based on timestamps
      console.log(`Would delete WAL files older than ${beforeDate.toISOString()}`);
      console.log(chalk.dim(`Run without ${chalk.bold('--dry-run')} to perform cleanup`));
    } else {
      console.log('No files old enough to delete');
    }
  } else {
    const deletedCount = await withProgress('Clean up old WAL files', async () => {
      return await wal.cleanupOldWALs(datasetName, retentionDays);
    });
    console.log(`Deleted ${deletedCount} old WAL files`);

    // Get archive info after cleanup
    const afterInfo = await wal.getArchiveInfo(datasetName);
    const savedBytes = beforeInfo.sizeBytes - afterInfo.sizeBytes;

    console.log();
    console.log(chalk.bold('Cleanup Summary:'));
    console.log(chalk.dim('  Files deleted:  '), deletedCount);
    console.log(chalk.dim('  Space freed:    '), formatSize(savedBytes));
    console.log(chalk.dim('  Files remaining:'), afterInfo.fileCount);
    console.log();
  }
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);

  return `${size.toFixed(2)} ${units[i]}`;
}
