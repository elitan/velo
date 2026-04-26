import chalk from 'chalk';
import { CLI_NAME } from '../../config/constants';
import { PATHS } from '../../utils/paths';
import { getStateInfo } from '../../services/state-info-service';

export async function stateInfoCommand(stateFile = PATHS.STATE) {
  const info = await getStateInfo(stateFile);

  console.log();
  console.log(chalk.bold(`${CLI_NAME} State`));
  console.log();

  console.log(chalk.bold('State file:'));
  console.log(`  Location: ${info.stateFile}`);
  console.log(`  Status: ${getStateStatus(info)}`);
  console.log();

  console.log(chalk.bold('Schema:'));
  console.log(`  Current: ${info.currentSchemaVersion}`);
  console.log(`  File: ${info.schemaVersion ?? 'none'}`);
  console.log(`  Status: ${getSchemaStatus(info.schemaStatus)}`);

  if (info.error) {
    console.log(`  Error: ${info.error}`);
  }

  console.log();

  if (info.initialized) {
    console.log(chalk.bold('Data:'));
    console.log(`  Projects: ${info.projectCount}`);
    console.log(`  Branches: ${info.branchCount}`);
    console.log(`  Snapshots: ${info.snapshotCount}`);
    console.log(`  ZFS pool: ${info.zfsPool}`);
    console.log(`  Dataset base: ${info.zfsDatasetBase}`);
    console.log(`  Initialized: ${info.initializedAt}`);
    console.log();
  }

  console.log(chalk.bold('Backup:'));
  console.log(`  Location: ${info.backupFile}`);

  if (info.backup.exists) {
    console.log('  Status: available');
    console.log(`  Modified: ${info.backup.modifiedAt?.toLocaleString()}`);
    console.log(`  Size: ${formatSize(info.backup.size || 0)}`);
    console.log(`  Restore: ${CLI_NAME} state restore`);
  } else {
    console.log('  Status: none');
    console.log('  Restore: no backup available');
  }

  console.log();
}

function getStateStatus(info: Awaited<ReturnType<typeof getStateInfo>>): string {
  if (!info.exists) {
    return 'not initialized';
  }

  if (!info.initialized) {
    return 'not usable';
  }

  return 'initialized';
}

function getSchemaStatus(status: string): string {
  if (status === 'current') {
    return 'current';
  }

  if (status === 'migrated') {
    return 'migrated';
  }

  if (status === 'unsupported') {
    return 'unsupported';
  }

  if (status === 'invalid') {
    return 'invalid';
  }

  return 'missing';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }

  return `${Math.round(bytes / 1024)}KB`;
}
