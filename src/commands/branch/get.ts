import Table from 'cli-table3';
import chalk from 'chalk';
import { formatBytes } from '../../utils/helpers';
import { parseNamespace } from '../../utils/namespace';
import { UserError } from '../../errors';
import { getPublicIPForBranch, formatConnectionString } from '../../utils/network';
import { CLI_NAME } from '../../config/constants';
import { initializeServices } from '../../utils/service-factory';
import { getBranchHealth } from '../../services/branch-health-service';
import type { SnapshotPolicy } from '../../types/state';

export async function branchGetCommand(name: string) {
  const namespace = parseNamespace(name);

  const { state, zfs, docker, wal } = await initializeServices();

  const result = state.branches.getByNamespace(name);
  if (!result) {
    throw new UserError(
      `Branch '${name}' not found`,
      `Run '${CLI_NAME} branch list' to see available branches`
    );
  }

  const { branch, project } = result;
  const health = await getBranchHealth(branch, { zfs, docker, wal });

  console.log();
  console.log(chalk.bold(`Branch: ${name}`));
  console.log();
  console.log(chalk.dim('  Status       '), branch.status === 'running' ? 'running' : 'stopped');
  console.log(chalk.dim('  Health       '), health.reason);
  console.log(chalk.dim('  Message      '), health.message);
  if (health.hint) {
    console.log(chalk.dim('  Hint         '), health.hint);
  }
  console.log(chalk.dim('  Container    '), health.containerName);
  console.log(chalk.dim('  Observed     '), health.observedStatus);
  console.log(chalk.dim('  Port         '), branch.port.toString());
  console.log(chalk.dim('  Size         '), health.sizeBytes === null ? 'unknown' : formatBytes(health.sizeBytes));
  console.log(chalk.dim('  Idle stop    '), formatIdleStop(branch.idleStop));
  console.log(chalk.dim('  Snapshots    '), formatSnapshotPolicy(branch.snapshotPolicy));
  console.log(chalk.dim('  Created      '), new Date(branch.createdAt).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC'));
  if (branch.parentBranchId) {
    const parentBranch = project.branches.find(b => b.id === branch.parentBranchId);
    if (parentBranch) {
      console.log(chalk.dim('  Parent       '), parentBranch.name);
    }
  }
  if (branch.snapshotName) {
    const snapshotShortName = branch.snapshotName.split('@')[1];
    console.log(chalk.dim('  Snapshot     '), snapshotShortName);
  }
  const publicIP = await getPublicIPForBranch(branch);

  console.log();
  console.log(chalk.bold('Connection:'));
  console.log(formatConnectionString(
    project.credentials.username,
    project.credentials.password,
    branch.port,
    project.credentials.database,
    publicIP
  ));
  console.log();
}

function formatSnapshotPolicy(policy: SnapshotPolicy | undefined): string {
  if (!policy?.enabled) {
    return 'disabled';
  }

  const parts = [
    `enabled (${policy.interval})`,
    `snapshot retention ${policy.retentionDays}d`,
    `WAL retention ${policy.walRetentionDays}d`,
  ];

  if (policy.lastRunAt) {
    parts.push(`last run ${policy.lastRunAt}`);
  }

  if (policy.nextRunAt) {
    parts.push(`next run ${policy.nextRunAt}`);
  }

  if (policy.lastFailure) {
    parts.push(`failure: ${policy.lastFailure}`);
  }

  return parts.join(', ');
}

function formatIdleStop(idleStop: { enabled: boolean; idleMinutes: number; lastActiveAt?: string; stoppedReason?: string } | undefined): string {
  if (!idleStop?.enabled) {
    return 'disabled';
  }

  const parts = [`enabled (${idleStop.idleMinutes}m)`];

  if (idleStop.lastActiveAt) {
    parts.push(`last active ${idleStop.lastActiveAt}`);
  }

  if (idleStop.stoppedReason) {
    parts.push(`stopped: ${idleStop.stoppedReason}`);
  }

  return parts.join(', ');
}
