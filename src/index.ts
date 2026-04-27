#!/usr/bin/env bun

import { Command } from 'commander';
import chalk from 'chalk';
import { CLI_NAME } from './config/constants';
import { projectCreateCommand } from './commands/project/create';
import { projectListCommand } from './commands/project/list';
import { projectGetCommand } from './commands/project/get';
import { projectDeleteCommand } from './commands/project/delete';
import { branchCreateCommand } from './commands/branch/create';
import { branchListCommand } from './commands/branch/list';
import { branchGetCommand } from './commands/branch/get';
import { branchDeleteCommand } from './commands/branch/delete';
import { branchResetCommand } from './commands/branch/reset';
import { branchPasswordCommand } from './commands/branch/password';
import { walInfoCommand } from './commands/wal/info';
import { walCleanupCommand } from './commands/wal/cleanup';
import { snapshotCreateCommand } from './commands/snapshot/create';
import { snapshotListCommand } from './commands/snapshot/list';
import { snapshotDeleteCommand } from './commands/snapshot/delete';
import { snapshotCleanupCommand } from './commands/snapshot/cleanup';
import {
  snapshotScheduleCronInstallCommand,
  snapshotScheduleCronListCommand,
  snapshotScheduleCronRemoveCommand,
  snapshotScheduleDisableCommand,
  snapshotScheduleEnableCommand,
  snapshotScheduleListCommand,
  snapshotScheduleRunCommand,
} from './commands/snapshot/schedule';
import { startCommand } from './commands/start';
import { stopCommand } from './commands/stop';
import { restartCommand } from './commands/restart';
import { statusCommand } from './commands/status';
import { doctorCommand } from './commands/doctor';
import { cleanupCommand } from './commands/cleanup';
import { setupCommand } from './commands/setup';
import { stateRestoreCommand } from './commands/state/restore';
import { stateInfoCommand } from './commands/state/info';
import {
  idleStopDisableCommand,
  idleStopEnableCommand,
  idleStopListCommand,
  idleStopRunCommand,
} from './commands/lifecycle/idle-stop';
import { wrapCommand } from './utils/command-wrapper';
import packageJson from '../package.json';

const program = new Command();

program
  .name(CLI_NAME)
  .description('PostgreSQL database branching using ZFS snapshots')
  .version(packageJson.version);

// ============================================================================
// Project commands
// ============================================================================

const projectCommand = program
  .command('project')
  .description('Manage projects');

projectCommand
  .command('create')
  .description('Create a new project with main branch')
  .argument('<name>', 'project name')
  .option('--pool <name>', 'ZFS pool to use (auto-detected if not specified)')
  .option('--pg-version <version>', 'PostgreSQL version (e.g., 17, 16)')
  .option('--image <image>', 'Custom Docker image (e.g., ankane/pgvector:17)')
  .option('--public', 'bind PostgreSQL to all host interfaces')
  .action(wrapCommand(async function createProjectAction(
    name: string,
    options: { pool?: string; pgVersion?: string; image?: string; public?: boolean }
  ) {
    // Map pgVersion to version for backwards compat
    const opts = { ...options, version: options.pgVersion };
    await projectCreateCommand(name, opts);
  }, { operationLock: true }));

projectCommand
  .command('list')
  .description('List all projects')
  .action(wrapCommand(async () => {
    await projectListCommand();
  }));

projectCommand
  .command('get')
  .description('Get details about a project')
  .argument('<name>', 'project name')
  .action(wrapCommand(async (name: string) => {
    await projectGetCommand(name);
  }));

projectCommand
  .command('delete')
  .description('Delete a project and all its branches')
  .argument('<name>', 'project name')
  .option('-f, --force', 'force delete even if branches exist')
  .action(wrapCommand(async (name: string, options: { force?: boolean }) => {
    await projectDeleteCommand(name, options);
  }, { operationLock: true }));


// ============================================================================
// Branch commands
// ============================================================================

const branchCommand = program
  .command('branch')
  .description('Manage branches within projects');

branchCommand
  .command('create')
  .description('Create a new branch from parent')
  .argument('<name>', 'branch name in format: <project>/<branch>')
  .option('--parent <parent>', 'parent branch (defaults to <project>/main)')
  .option('--pitr <time>', 'recover to point in time (e.g., "2025-10-07T14:30:00Z", "2 hours ago")')
  .option('--public', 'bind PostgreSQL to all host interfaces')
  .action(wrapCommand(async function createBranchAction(
    name: string,
    options: { parent?: string; pitr?: string; public?: boolean }
  ) {
    await branchCreateCommand(name, options);
  }, { operationLock: true }));

branchCommand
  .command('list')
  .description('List branches')
  .argument('[project]', 'project name (optional, lists all if not specified)')
  .action(wrapCommand(async (project?: string) => {
    await branchListCommand(project);
  }));

branchCommand
  .command('get')
  .description('Get details about a branch')
  .argument('<name>', 'branch name in format: <project>/<branch>')
  .action(wrapCommand(async (name: string) => {
    await branchGetCommand(name);
  }));

branchCommand
  .command('delete')
  .description('Delete a branch')
  .argument('<name>', 'branch name in format: <project>/<branch>')
  .option('-f, --force', 'delete branch and all child branches')
  .action(wrapCommand(async (name: string, options: { force?: boolean }) => {
    await branchDeleteCommand(name, options);
  }, { operationLock: true }));

branchCommand
  .command('reset')
  .description('Reset branch to parent\'s current state')
  .argument('<name>', 'branch name in format: <project>/<branch>')
  .option('-f, --force', 'force reset even if dependent branches exist (will destroy them)')
  .action(wrapCommand(async (name: string, options: { force?: boolean }) => {
    await branchResetCommand(name, options);
  }, { operationLock: true }));

branchCommand
  .command('password')
  .description('Show connection details and password for a branch')
  .argument('<name>', 'branch name in format: <project>/<branch>')
  .action(wrapCommand(async (name: string) => {
    await branchPasswordCommand(name);
  }));

branchCommand
  .command('start')
  .description('Start a stopped branch')
  .argument('<name>', 'branch name in format: <project>/<branch>')
  .action(wrapCommand(async (name: string) => {
    await startCommand(name);
  }, { operationLock: true }));

branchCommand
  .command('stop')
  .description('Stop a running branch')
  .argument('<name>', 'branch name in format: <project>/<branch>')
  .action(wrapCommand(async (name: string) => {
    await stopCommand(name);
  }, { operationLock: true }));

branchCommand
  .command('restart')
  .description('Restart a branch')
  .argument('<name>', 'branch name in format: <project>/<branch>')
  .action(wrapCommand(async (name: string) => {
    await restartCommand(name);
  }, { operationLock: true }));

// ============================================================================
// WAL commands
// ============================================================================

const walCommand = program
  .command('wal')
  .description('Manage WAL archives');

walCommand
  .command('info')
  .description('Show WAL archive status')
  .argument('[branch]', 'branch name in format: <project>/<branch> (optional, shows all if not specified)')
  .action(wrapCommand(async (branch?: string) => {
    await walInfoCommand(branch);
  }));

walCommand
  .command('cleanup')
  .description('Clean up old WAL files')
  .argument('<branch>', 'branch name in format: <project>/<branch>')
  .option('--days <days>', 'retention period in days (default: 7)', '7')
  .option('--dry-run', 'show what would be deleted without actually deleting')
  .action(wrapCommand(async (branch: string, options: { days?: string; dryRun?: boolean }) => {
    await walCleanupCommand(branch, {
      days: options.days ? parseInt(options.days, 10) : 7,
      dryRun: options.dryRun,
    });
  }, { operationLock: true }));

// ============================================================================
// Snapshot commands
// ============================================================================

const snapshotCommand = program
  .command('snapshot')
  .description('Manage snapshots for point-in-time recovery');

snapshotCommand
  .command('create')
  .description('Create a snapshot of a branch')
  .argument('<branch>', 'branch name in format: <project>/<branch>')
  .option('--label <label>', 'optional label for the snapshot')
  .action(wrapCommand(async (branch: string, options: { label?: string }) => {
    await snapshotCreateCommand(branch, options);
  }, { operationLock: true }));

snapshotCommand
  .command('list')
  .description('List snapshots')
  .argument('[branch]', 'branch name in format: <project>/<branch> (optional, lists all if not specified)')
  .action(wrapCommand(async (branch?: string) => {
    await snapshotListCommand(branch);
  }));

snapshotCommand
  .command('delete')
  .description('Delete a snapshot')
  .argument('<snapshot-id>', 'snapshot ID')
  .action(wrapCommand(async (snapshotId: string) => {
    await snapshotDeleteCommand(snapshotId);
  }, { operationLock: true }));

snapshotCommand
  .command('cleanup')
  .description('Clean up old snapshots')
  .argument('[branch]', 'branch name in format: <project>/<branch> (optional with --all)')
  .option('--days <days>', 'retention period in days (default: 30)', '30')
  .option('--dry-run', 'show what would be deleted without actually deleting')
  .option('--all', 'cleanup snapshots across all branches')
  .action(wrapCommand(async (branch: string | undefined, options: { days?: string; dryRun?: boolean; all?: boolean }) => {
    await snapshotCleanupCommand(branch, {
      days: options.days ? parseInt(options.days, 10) : 30,
      dryRun: options.dryRun,
      all: options.all,
    });
  }, { operationLock: true }));

const snapshotScheduleCommand = snapshotCommand
  .command('schedule')
  .description('Manage built-in snapshot schedules');

snapshotScheduleCommand
  .command('enable')
  .description('Enable scheduled snapshots for a branch')
  .argument('<branch>', 'branch name in format: <project>/<branch>')
  .requiredOption('--interval <interval>', 'hourly or daily')
  .option('--retention-days <days>', 'snapshot retention period in days', '30')
  .option('--wal-retention-days <days>', 'WAL retention period in days', '7')
  .action(wrapCommand(async function (branch: string, options: { interval: string; retentionDays: string; walRetentionDays: string }) {
    await snapshotScheduleEnableCommand(branch, {
      interval: options.interval,
      retentionDays: parseInt(options.retentionDays, 10),
      walRetentionDays: parseInt(options.walRetentionDays, 10),
    });
  }, { operationLock: true }));

snapshotScheduleCommand
  .command('disable')
  .description('Disable scheduled snapshots for a branch')
  .argument('<branch>', 'branch name in format: <project>/<branch>')
  .action(wrapCommand(async function (branch: string) {
    await snapshotScheduleDisableCommand(branch);
  }, { operationLock: true }));

snapshotScheduleCommand
  .command('list')
  .description('List snapshot schedules')
  .action(wrapCommand(async function () {
    await snapshotScheduleListCommand();
  }));

snapshotScheduleCommand
  .command('run')
  .description('Apply scheduled snapshot policies')
  .argument('[branch]', 'branch name in format: <project>/<branch>')
  .option('--dry-run', 'show what would happen without creating or deleting files')
  .action(wrapCommand(async function (branch: string | undefined, options: { dryRun?: boolean }) {
    await snapshotScheduleRunCommand(branch, options);
  }, { operationLock: true }));

const snapshotScheduleCronCommand = snapshotScheduleCommand
  .command('cron')
  .description('Manage cron runner for snapshot schedules');

snapshotScheduleCronCommand
  .command('install')
  .description('Install cron runner for snapshot schedules')
  .option('--every-minutes <minutes>', 'run interval in minutes', '5')
  .option('--command <command>', 'command to run from cron')
  .action(wrapCommand(async function (options: { everyMinutes: string; command?: string }) {
    await snapshotScheduleCronInstallCommand({
      everyMinutes: parseInt(options.everyMinutes, 10),
      command: options.command,
    });
  }));

snapshotScheduleCronCommand
  .command('list')
  .description('Show installed snapshot schedule cron runner')
  .action(wrapCommand(async function () {
    await snapshotScheduleCronListCommand();
  }));

snapshotScheduleCronCommand
  .command('remove')
  .description('Remove snapshot schedule cron runner')
  .action(wrapCommand(async function () {
    await snapshotScheduleCronRemoveCommand();
  }));

// ============================================================================
// Global commands
// ============================================================================

program
  .command('status')
  .description('Show status of all projects and branches')
  .action(wrapCommand(async () => {
    await statusCommand();
  }));

program
  .command('doctor')
  .description('Run health checks and diagnostics')
  .action(wrapCommand(async () => {
    await doctorCommand();
  }));

program
  .command('cleanup')
  .description('Remove orphaned ZFS datasets and Docker containers')
  .option('--dry-run', 'show what would be deleted without actually deleting')
  .option('-f, --force', 'skip confirmation prompt')
  .action(wrapCommand(async (options: { dryRun?: boolean; force?: boolean }) => {
    await cleanupCommand(options);
  }, { operationLock: true }));

program
  .command('setup')
  .description('One-time setup: grant ZFS permissions and configure Docker (uses sudo internally)')
  .action(wrapCommand(async function () {
    await setupCommand();
  }));

const lifecycleCommand = program
  .command('lifecycle')
  .description('Manage branch lifecycle policies');

const idleStopCommand = lifecycleCommand
  .command('idle-stop')
  .description('Manage idle auto-stop policies');

idleStopCommand
  .command('enable')
  .description('Enable idle auto-stop for a branch')
  .argument('<branch>', 'branch name in format: <project>/<branch>')
  .requiredOption('--minutes <minutes>', 'idle minutes before stopping')
  .action(wrapCommand(async (branch: string, options: { minutes: string }) => {
    await idleStopEnableCommand(branch, {
      minutes: parseInt(options.minutes, 10),
    });
  }, { operationLock: true }));

idleStopCommand
  .command('disable')
  .description('Disable idle auto-stop for a branch')
  .argument('<branch>', 'branch name in format: <project>/<branch>')
  .action(wrapCommand(async (branch: string) => {
    await idleStopDisableCommand(branch);
  }, { operationLock: true }));

idleStopCommand
  .command('list')
  .description('List idle auto-stop policies')
  .action(wrapCommand(async () => {
    await idleStopListCommand();
  }));

idleStopCommand
  .command('run')
  .description('Apply idle auto-stop policies')
  .argument('[branch]', 'branch name in format: <project>/<branch>')
  .option('--dry-run', 'show what would happen without stopping branches')
  .action(wrapCommand(async (branch: string | undefined, options: { dryRun?: boolean }) => {
    await idleStopRunCommand(branch, options);
  }, { operationLock: true }));

// ============================================================================
// State commands
// ============================================================================

const stateCommand = program
  .command('state')
  .description('Manage state file');

stateCommand
  .command('info')
  .description('Show state file and backup info')
  .action(wrapCommand(async () => {
    await stateInfoCommand();
  }));

stateCommand
  .command('restore')
  .description('Restore state from backup')
  .action(wrapCommand(async () => {
    await stateRestoreCommand();
  }, { operationLock: true }));

program.parse();
