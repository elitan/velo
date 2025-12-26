import chalk from 'chalk';
import { UserError } from '../../errors';
import { withProgress } from '../../utils/progress';
import { CLI_NAME } from '../../config/constants';
import { initializeServices } from '../../utils/service-factory';

export async function snapshotDeleteCommand(snapshotId: string) {
  console.log();
  console.log(`Deleting snapshot ${chalk.bold(snapshotId)}...`);
  console.log();

  const { state, zfs } = await initializeServices();

  // Find the snapshot
  const snapshot = state.snapshots.getById(snapshotId);
  if (!snapshot) {
    throw new UserError(
      `Snapshot not found: ${snapshotId}`,
      `Run '${CLI_NAME} snapshot list' to see available snapshots`
    );
  }

  // Delete ZFS snapshot
  await withProgress('Delete ZFS snapshot', async () => {
    await zfs.destroySnapshot(snapshot.zfsSnapshot);
  });

  // Remove from state
  await state.snapshots.delete(snapshotId);

  console.log();
  console.log(chalk.bold('Snapshot deleted'));
  console.log();
}
