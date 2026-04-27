import chalk from 'chalk';
import { parseNamespace } from '../../utils/namespace';
import { createBranchSnapshot } from '../../services/snapshot-service';
import { initializeServices, getBranchWithProject } from '../../utils/service-factory';

export interface SnapshotCreateOptions {
  label?: string;
}

export async function snapshotCreateCommand(branchName: string, options: SnapshotCreateOptions = {}) {
  const target = parseNamespace(branchName);

  console.log();
  if (options.label) {
    console.log(`Creating snapshot of ${chalk.bold(target.full)} (${chalk.dim(options.label)})...`);
  } else {
    console.log(`Creating snapshot of ${chalk.bold(target.full)}...`);
  }
  console.log();

  const { state, zfs, docker, stateData } = await initializeServices();

  const { branch, project: proj } = await getBranchWithProject(state, target.full);
  const { snapshot, snapshotName } = await createBranchSnapshot({
    state,
    stateData,
    branch,
    project: proj,
    label: options.label,
    zfs,
    docker,
  });

  console.log();
  console.log(chalk.bold('Snapshot created'));
  console.log();
  console.log(`  ID: ${snapshot.id}`);
  console.log(`  Name: ${snapshotName}`);
  console.log();
}
