import Table from 'cli-table3';
import chalk from 'chalk';
import { UserError } from '../../errors';
import { CLI_NAME } from '../../config/constants';
import { createBranchSnapshot } from '../../services/snapshot-service';
import {
  disableSnapshotPolicy,
  enableSnapshotPolicy,
  formatSnapshotScheduleDryRun,
  getExpiredSnapshots,
  getSnapshotSchedulePlan,
  recordSnapshotPolicyFailure,
  recordSnapshotPolicySuccess,
  type SnapshotSchedulePlan,
} from '../../services/snapshot-policy-service';
import {
  getSnapshotScheduleRunnerInfo,
  installSnapshotScheduleCron,
  removeSnapshotScheduleCron,
} from '../../services/snapshot-runner-service';
import { getBranchWithProject, initializeServices } from '../../utils/service-factory';
import type { Branch, Project, Snapshot, SnapshotScheduleInterval } from '../../types/state';
import type { ZFSManager } from '../../managers/zfs';

export interface SnapshotScheduleEnableOptions {
  interval: string;
  retentionDays: number;
  walRetentionDays: number;
}

export interface SnapshotScheduleCronInstallOptions {
  everyMinutes: number;
  command?: string;
}

export async function snapshotScheduleEnableCommand(name: string, options: SnapshotScheduleEnableOptions) {
  const interval = validateInterval(options.interval);
  const retentionDays = validateDays(options.retentionDays, 'Snapshot retention days');
  const walRetentionDays = validateDays(options.walRetentionDays, 'WAL retention days');
  const { state } = await initializeServices();
  const { branch, project } = await getBranchWithProject(state, name);

  await enableSnapshotPolicy(branch, project.id, state, {
    interval,
    retentionDays,
    walRetentionDays,
  });

  console.log();
  console.log(chalk.bold(`Snapshot schedule enabled for ${name}`));
  console.log(`Interval: ${interval}`);
  console.log(`Snapshot retention: ${retentionDays} day(s)`);
  console.log(`WAL retention: ${walRetentionDays} day(s)`);
  console.log(`Next run: ${branch.snapshotPolicy?.nextRunAt}`);
  console.log();
}

export async function snapshotScheduleDisableCommand(name: string) {
  const { state } = await initializeServices();
  const { branch, project } = await getBranchWithProject(state, name);

  await disableSnapshotPolicy(branch, project.id, state);

  console.log();
  console.log(chalk.bold(`Snapshot schedule disabled for ${name}`));
  console.log();
}

export async function snapshotScheduleListCommand() {
  const { state } = await initializeServices();
  const projects = state.projects.list();

  console.log();
  console.log(chalk.bold('Snapshot Schedules'));
  console.log();

  const table = new Table({
    head: ['Branch', 'Enabled', 'Interval', 'Snapshot retention', 'WAL retention', 'Last run', 'Next run', 'Failure'],
    style: {
      head: [],
      border: ['gray'],
    },
  });

  for (const project of projects) {
    for (const branch of project.branches) {
      const policy = branch.snapshotPolicy;
      table.push([
        branch.name,
        policy?.enabled ? 'yes' : 'no',
        policy?.enabled ? policy.interval : chalk.dim('—'),
        policy?.enabled ? `${policy.retentionDays}d` : chalk.dim('—'),
        policy?.enabled ? `${policy.walRetentionDays}d` : chalk.dim('—'),
        policy?.lastRunAt || chalk.dim('—'),
        policy?.nextRunAt || chalk.dim('—'),
        policy?.lastFailure || chalk.dim('—'),
      ]);
    }
  }

  console.log(table.toString());
  console.log();
}

export async function snapshotScheduleRunCommand(name: string | undefined, options: { dryRun?: boolean } = {}) {
  const { state, zfs, docker, wal, stateData } = await initializeServices();
  const targets: Array<{ branch: Branch; project: Project }> = [];

  if (name) {
    targets.push(await getBranchWithProject(state, name));
  } else {
    for (const project of state.projects.list()) {
      for (const branch of project.branches) {
        if (branch.snapshotPolicy?.enabled) {
          targets.push({ branch, project });
        }
      }
    }
  }

  console.log();
  console.log(chalk.bold(options.dryRun ? 'Snapshot Schedule Dry Run' : 'Snapshot Schedule Run'));
  console.log();

  if (targets.length === 0) {
    console.log(chalk.dim(`No enabled snapshot schedules. Run ${CLI_NAME} snapshot schedule enable <branch>.`));
    console.log();
    return;
  }

  const table = new Table({
    head: ['Branch', 'Action', 'Snapshots', 'WAL', 'Next run', 'Message'],
    style: {
      head: [],
      border: ['gray'],
    },
  });
  let failures = 0;

  for (const target of targets) {
    const plan = getSnapshotSchedulePlan(target.branch);

    if (options.dryRun) {
      pushDryRunRow(table, target.branch, plan, state.snapshots.getForBranch(target.branch.name));
      continue;
    }

    if (plan.action !== 'due') {
      table.push([
        target.branch.name,
        plan.action,
        chalk.dim('—'),
        chalk.dim('—'),
        plan.nextRunAt || chalk.dim('—'),
        plan.message,
      ]);
      continue;
    }

    try {
      const policy = target.branch.snapshotPolicy!;
      await createBranchSnapshot({
        state,
        stateData,
        branch: target.branch,
        project: target.project,
        label: `scheduled-${policy.interval}`,
        zfs,
        docker,
      });

      const deletedSnapshots = await state.snapshots.deleteOld(target.branch.name, policy.retentionDays, false);
      const zfsFailures = await destroySnapshots(zfs, deletedSnapshots);
      const deletedWal = await wal.cleanupOldWALs(target.branch.zfsDataset, policy.walRetentionDays);

      await recordSnapshotPolicySuccess(target.branch, target.project.id, state);

      table.push([
        target.branch.name,
        'created',
        formatSnapshotCleanup(deletedSnapshots.length, zfsFailures),
        `${deletedWal} file(s)`,
        target.branch.snapshotPolicy?.nextRunAt || chalk.dim('—'),
        'policy applied',
      ]);
    } catch (error: any) {
      failures++;
      const message = getErrorMessage(error);
      await recordSnapshotPolicyFailure(target.branch, target.project.id, state, message);
      table.push([
        target.branch.name,
        'failed',
        chalk.dim('—'),
        chalk.dim('—'),
        target.branch.snapshotPolicy?.nextRunAt || chalk.dim('—'),
        message,
      ]);
    }
  }

  console.log(table.toString());
  console.log();

  if (failures > 0) {
    throw new UserError(`${failures} snapshot schedule(s) failed`);
  }
}

export async function snapshotScheduleCronInstallCommand(options: SnapshotScheduleCronInstallOptions) {
  const everyMinutes = validateCronMinutes(options.everyMinutes);
  const command = options.command || getDefaultSnapshotScheduleCommand();
  const current = await readCrontab();
  const next = installSnapshotScheduleCron(current, command, everyMinutes);

  await writeCrontab(next);

  console.log();
  console.log(chalk.bold('Snapshot schedule cron installed'));
  console.log(`Every: ${everyMinutes} minute(s)`);
  console.log(`Command: ${command}`);
  console.log();
}

export async function snapshotScheduleCronListCommand() {
  const current = await readCrontab();
  const info = getSnapshotScheduleRunnerInfo(current);

  console.log();
  console.log(chalk.bold('Snapshot Schedule Cron'));
  console.log();

  if (!info.installed) {
    console.log(chalk.dim('Not installed'));
    console.log();
    return;
  }

  console.log(`Every: ${info.everyMinutes ? `${info.everyMinutes} minute(s)` : 'unknown'}`);
  console.log(`Command: ${info.command || 'unknown'}`);
  console.log();
}

export async function snapshotScheduleCronRemoveCommand() {
  const current = await readCrontab();
  const next = removeSnapshotScheduleCron(current);

  if (next === current.trimEnd()) {
    console.log();
    console.log(chalk.dim('Snapshot schedule cron is not installed'));
    console.log();
    return;
  }

  await writeCrontab(next.length === 0 ? '' : `${next}\n`);

  console.log();
  console.log(chalk.bold('Snapshot schedule cron removed'));
  console.log();
}

function pushDryRunRow(
  table: any,
  branch: Branch,
  plan: SnapshotSchedulePlan,
  snapshots: Snapshot[]
): void {
  const policy = branch.snapshotPolicy;
  const expiredSnapshots = policy
    ? getExpiredSnapshots(snapshots, branch.name, policy.retentionDays)
    : [];

  table.push([
    branch.name,
    plan.action === 'due' ? 'would-run' : plan.action,
    plan.action === 'due' ? `${expiredSnapshots.length} old` : chalk.dim('—'),
    plan.action === 'due' ? `older than ${plan.walCutoffAt}` : chalk.dim('—'),
    plan.nextRunAt || chalk.dim('—'),
    formatSnapshotScheduleDryRun(plan, expiredSnapshots.length),
  ]);
}

async function destroySnapshots(zfs: ZFSManager, snapshots: Snapshot[]): Promise<number> {
  let failures = 0;

  for (const snapshot of snapshots) {
    try {
      await zfs.destroySnapshot(snapshot.zfsSnapshot);
    } catch {
      failures++;
    }
  }

  return failures;
}

function formatSnapshotCleanup(deletedCount: number, zfsFailures: number): string {
  if (zfsFailures === 0) {
    return `${deletedCount} old`;
  }

  return `${deletedCount} old, ${zfsFailures} zfs failed`;
}

function validateInterval(value: string): SnapshotScheduleInterval {
  if (value === 'hourly' || value === 'daily') {
    return value;
  }

  throw new UserError('Snapshot interval must be hourly or daily');
}

function validateDays(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new UserError(`${name} must be a positive integer`);
  }

  return value;
}

function validateCronMinutes(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 59) {
    throw new UserError('Cron interval minutes must be an integer from 1 to 59');
  }

  return value;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function readCrontab(): Promise<string> {
  const proc = Bun.spawn(['crontab', '-l'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode === 0) {
    return stdout;
  }

  if (stderr.toLowerCase().includes('no crontab')) {
    return '';
  }

  throw new UserError(`Failed to read crontab: ${stderr.trim() || `exit ${exitCode}`}`);
}

async function writeCrontab(content: string): Promise<void> {
  const proc = Bun.spawn(['crontab', '-'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  proc.stdin.write(content);
  proc.stdin.end();

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new UserError(`Failed to write crontab: ${stderr.trim() || `exit ${exitCode}`}`);
  }
}

function getDefaultSnapshotScheduleCommand(): string {
  const executable = process.argv[1] || CLI_NAME;
  return `${quoteShell(executable)} snapshot schedule run`;
}

function quoteShell(value: string): string {
  if (!/[\s'"]/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}
