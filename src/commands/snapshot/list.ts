import Table from 'cli-table3';
import chalk from 'chalk';
import { parseNamespace } from '../../utils/namespace';
import { formatBytes } from '../../utils/helpers';
import { formatRelativeTime } from '../../utils/time';
import { initializeServices } from '../../utils/service-factory';

export async function snapshotListCommand(branchName?: string) {
  const { state } = await initializeServices();

  let snapshots;
  let title;

  if (branchName) {
    const target = parseNamespace(branchName);
    snapshots = state.snapshots.getForBranch(target.full);
    title = `Snapshots for ${target.full}`;
  } else {
    snapshots = state.snapshots.getAll();
    title = 'All Snapshots';
  }

  console.log();
  console.log(chalk.bold(title));
  console.log();

  if (snapshots.length === 0) {
    console.log(chalk.dim('No snapshots found'));
    console.log();
    return;
  }

  // Sort by creation time (newest first)
  snapshots.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const table = new Table({
    head: ['ID', 'Branch', 'Label', 'Created', 'Size'],
    style: {
      head: [],
      border: ['gray']
    }
  });

  for (const snapshot of snapshots) {
    const id = snapshot.id.slice(0, 8);
    const created = formatRelativeTime(new Date(snapshot.createdAt));
    const size = formatBytes(snapshot.sizeBytes);
    const label = snapshot.label || chalk.dim('-');

    table.push([
      id,
      snapshot.branchName,
      label,
      created,
      size
    ]);
  }

  console.log(table.toString());
  console.log();
}
