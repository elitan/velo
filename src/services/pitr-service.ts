import { StateManager } from '../managers/state';
import type { Snapshot } from '../types/state';
import { UserError } from '../errors';
import { formatDate } from '../utils/time';
import { CLI_NAME } from '../config/constants';
import chalk from 'chalk';

export interface SnapshotSelection {
  fullSnapshotName: string;
  snapshotName: string;
  snapshot: Snapshot;
}

/**
 * Select the best snapshot for point-in-time recovery
 * Finds the most recent snapshot created BEFORE the recovery target time
 */
export async function selectSnapshotForPITR(
  sourceBranchName: string,
  recoveryTarget: Date,
  state: StateManager
): Promise<SnapshotSelection> {
  // Find snapshots for source branch
  const snapshots = await state.getSnapshotsForBranch(sourceBranchName);

  // Filter snapshots created BEFORE recovery target
  const validSnapshots = snapshots.filter(s =>
    new Date(s.createdAt) < recoveryTarget
  );

  if (validSnapshots.length === 0) {
    throw new UserError(
      `No snapshots found before recovery target ${formatDate(recoveryTarget)}`,
      `Create a snapshot with: ${CLI_NAME} snapshot create ${sourceBranchName} ${chalk.bold('--label')} <name>`
    );
  }

  // Sort by creation time (newest first) and take the closest one before target
  validSnapshots.sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  const selectedSnapshot = validSnapshots[0]!; // Safe: we checked validSnapshots.length > 0

  const fullSnapshotName = selectedSnapshot.zfsSnapshot;
  const parts = fullSnapshotName.split('@');
  if (parts.length !== 2 || !parts[1]) {
    throw new UserError(`Invalid snapshot name format: ${fullSnapshotName}`);
  }
  const snapshotName = parts[1];

  console.log(chalk.dim(`  Using snapshot: ${selectedSnapshot.label || snapshotName} (created ${formatDate(new Date(selectedSnapshot.createdAt))})`));
  console.log();

  return {
    fullSnapshotName,
    snapshotName,
    snapshot: selectedSnapshot,
  };
}
