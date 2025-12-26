/**
 * Cleanup orphaned resources
 */

import chalk from 'chalk';
import { detectOrphans } from '../utils/orphan-detection';
import { formatBytes } from '../utils/helpers';
import { UserError } from '../errors';
import * as readline from 'readline';
import { initializeServices } from '../utils/service-factory';

interface CleanupOptions {
  dryRun?: boolean;
  force?: boolean;
}

export async function cleanupCommand(options: CleanupOptions = {}) {
  console.log();
  console.log(chalk.bold('Orphaned Resource Cleanup'));
  console.log(chalk.dim('═'.repeat(60)));
  console.log();

  const { state, zfs, docker, stateData } = await initializeServices();

  if (!state.isInitialized()) {
    throw new UserError('State not initialized. Create your first project to initialize velo.');
  }

  // Detect orphans
  console.log('Scanning for orphaned resources...');
  const result = await detectOrphans(stateData, zfs, docker);
  console.log();

  if (result.totalOrphans === 0) {
    console.log(chalk.green('✓ No orphaned resources found'));
    console.log();
    return;
  }

  // Display findings
  console.log(chalk.yellow(`Found ${result.totalOrphans} orphaned resource(s):`));
  console.log();

  if (result.datasets.length > 0) {
    console.log(chalk.bold('Orphaned ZFS Datasets:'));
    for (const dataset of result.datasets) {
      console.log(`  • ${dataset.name} (${formatBytes(dataset.sizeBytes)}, created ${dataset.createdAt.toISOString()})`);
    }
    console.log();
  }

  if (result.containers.length > 0) {
    console.log(chalk.bold('Orphaned Docker Containers:'));
    for (const container of result.containers) {
      console.log(`  • ${container.name} (${container.state}, created ${container.createdAt.toISOString()})`);
    }
    console.log();
  }

  console.log(chalk.dim(`Total wasted disk space: ${formatBytes(result.totalWastedBytes)}`));
  console.log();

  // Dry run mode
  if (options.dryRun) {
    console.log(chalk.cyan('DRY RUN MODE - No resources will be deleted'));
    console.log();
    console.log('Would delete:');
    for (const dataset of result.datasets) {
      console.log(`  - ZFS dataset: ${dataset.fullPath}`);
    }
    for (const container of result.containers) {
      console.log(`  - Docker container: ${container.name}`);
    }
    console.log();
    console.log(`Run without ${chalk.bold('--dry-run')} to actually delete these resources`);
    console.log();
    return;
  }

  // Confirm deletion (unless --force is used)
  if (!options.force) {
    const confirmed = await confirm('Do you want to delete these orphaned resources?');
    if (!confirmed) {
      console.log();
      console.log('Cleanup cancelled');
      console.log();
      return;
    }
  }

  // Delete orphaned resources
  console.log();
  console.log('Cleaning up orphaned resources...');
  console.log();

  let deletedDatasets = 0;
  let deletedContainers = 0;
  let errors: string[] = [];

  // Delete containers first (they might be using datasets)
  for (const container of result.containers) {
    try {
      await docker.removeContainer(container.id);
      console.log(chalk.green(`✓ Removed container: ${container.name}`));
      deletedContainers++;
    } catch (error: any) {
      const errorMsg = `Failed to remove container ${container.name}: ${error.message}`;
      console.log(chalk.red(`✗ ${errorMsg}`));
      errors.push(errorMsg);
    }
  }

  // Delete datasets
  for (const dataset of result.datasets) {
    try {
      await zfs.destroyDataset(dataset.name, true);
      console.log(chalk.green(`✓ Removed dataset: ${dataset.name} (freed ${formatBytes(dataset.sizeBytes)})`));
      deletedDatasets++;
    } catch (error: any) {
      const errorMsg = `Failed to remove dataset ${dataset.name}: ${error.message}`;
      console.log(chalk.red(`✗ ${errorMsg}`));
      errors.push(errorMsg);
    }
  }

  // Summary
  console.log();
  console.log(chalk.dim('─'.repeat(60)));
  console.log();
  console.log(chalk.bold('Summary:'));
  console.log(`  Datasets removed: ${deletedDatasets}/${result.datasets.length}`);
  console.log(`  Containers removed: ${deletedContainers}/${result.containers.length}`);

  if (errors.length > 0) {
    console.log();
    console.log(chalk.yellow(`⚠ ${errors.length} error(s) occurred during cleanup`));
  } else if (deletedDatasets + deletedContainers > 0) {
    console.log();
    console.log(chalk.green(`✓ Successfully cleaned up ${deletedDatasets + deletedContainers} orphaned resource(s)`));
    console.log(chalk.green(`  Freed ${formatBytes(result.totalWastedBytes)} of disk space`));
  }

  console.log();
}

/**
 * Prompt user for confirmation
 */
async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}
