import chalk from 'chalk';
import { parseNamespace } from '../../utils/namespace';
import { UserError } from '../../errors';
import { withProgress } from '../../utils/progress';
import { CLI_NAME } from '../../config/constants';
import { initializeServices, getBranchWithProject } from '../../utils/service-factory';

export interface SnapshotCleanupOptions {
  days: number;
  dryRun?: boolean;
  all?: boolean;
}

export async function snapshotCleanupCommand(
  branchName: string | undefined,
  options: SnapshotCleanupOptions
) {
  console.log();
  if (options.all) {
    console.log(chalk.bold(`Cleaning up snapshots older than ${options.days} days (all branches)`));
  } else if (branchName) {
    const target = parseNamespace(branchName);
    console.log(chalk.bold(`Cleaning up snapshots for ${target.full}`));
    console.log(chalk.dim(`Retention: ${options.days} days`));
  } else {
    throw new UserError(
      `Must specify branch name or use ${chalk.bold('--all')} flag`,
      `Usage: '${CLI_NAME} snapshot cleanup <project>/<branch> ${chalk.bold('--days')} <n>' or '${CLI_NAME} snapshot cleanup ${chalk.bold('--all')} ${chalk.bold('--days')} <n>'`
    );
  }

  if (options.dryRun) {
    console.log('Dry run - no snapshots will be deleted');
  }
  console.log();

  const { state, zfs } = await initializeServices();

  let deleted: any[] = [];

  if (options.all) {
    // Clean up snapshots across all branches
    deleted = await withProgress('Find old snapshots', async () => {
      return await state.snapshots.deleteOld(undefined, options.days, options.dryRun);
    });
    console.log(`Found ${deleted.length} snapshot(s) to delete`);
  } else if (branchName) {
    // Clean up snapshots for specific branch
    const { branch } = await getBranchWithProject(state, branchName);

    deleted = await withProgress('Find old snapshots', async () => {
      return await state.snapshots.deleteOld(branch.name, options.days, options.dryRun);
    });
    console.log(`Found ${deleted.length} snapshot(s) to delete`);
  }

  if (deleted.length === 0) {
    console.log('No snapshots to clean up');
    console.log();
    return;
  }

  // Display what will be deleted
  console.log();
  for (const snap of deleted) {
    const age = Math.floor(
      (Date.now() - new Date(snap.createdAt).getTime()) / (1000 * 60 * 60 * 24)
    );
    console.log(
      chalk.dim('  •'),
      snap.label || snap.id.substring(0, 8),
      chalk.dim(`(${snap.branchName}, ${age} days old)`)
    );
  }
  console.log();

  if (!options.dryRun) {
    // Delete the actual ZFS snapshots
    await withProgress('Delete ZFS snapshots', async () => {
      for (const snap of deleted) {
        try {
          await zfs.destroySnapshot(snap.zfsSnapshot);
        } catch (error: any) {
          console.log();
          console.log(`Warning: Failed to delete snapshot ${snap.id}: ${error.message}`);
        }
      }
    });
    console.log(`Deleted ${deleted.length} snapshot(s)`);
  }

  console.log();
  console.log(chalk.bold(`Cleanup ${options.dryRun ? 'preview' : 'complete'}`));
  console.log();
}
