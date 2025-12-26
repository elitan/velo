import chalk from 'chalk';
import { parseNamespace } from '../../utils/namespace';
import { getContainerName, getDatasetName } from '../../utils/naming';
import { UserError } from '../../errors';
import { withProgress } from '../../utils/progress';
import { CLI_NAME } from '../../config/constants';
import { initializeServices, getBranchWithProject } from '../../utils/service-factory';
import { buildBranchTree, renderBranchTree } from '../../utils/tree-renderer';
import type { Branch } from '../../types/state';

// Helper function to collect all descendant branches recursively (depth-first, post-order)
function collectDescendants(branch: Branch, allBranches: Branch[]): Branch[] {
  const children = allBranches.filter(b => b.parentBranchId === branch.id);
  const descendants: Branch[] = [];

  for (const child of children) {
    // Recursively collect descendants of this child first
    descendants.push(...collectDescendants(child, allBranches));
    // Then add the child itself
    descendants.push(child);
  }

  return descendants;
}

export async function branchDeleteCommand(name: string, options: { force?: boolean } = {}) {
  const namespace = parseNamespace(name);

  console.log();
  console.log(`Deleting ${chalk.bold(name)}...`);
  console.log();

  const { state, docker, zfs, wal, stateData } = await initializeServices();
  const { branch, project } = await getBranchWithProject(state, name);

  // Prevent deleting main branch
  if (branch.isPrimary) {
    throw new UserError(
      `Cannot delete main branch. Use '${CLI_NAME} project delete ${project.name}' to delete the entire project.`,
      `Main branches can only be deleted by deleting the entire project`
    );
  }

  // Check for child branches
  const descendants = collectDescendants(branch, project.branches);
  if (descendants.length > 0 && !options.force) {
    console.log(`Branch '${chalk.bold(name)}' has ${descendants.length} child branch(es):`);

    // Build and render tree structure
    const { nodeMap } = buildBranchTree([branch, ...descendants]);
    const rootNode = nodeMap.get(branch.id)!;
    renderBranchTree([rootNode]);

    console.log();
    console.log(`Use ${chalk.bold('--force')} to delete branch and all child branches`);

    throw new UserError(`Branch '${name}' has ${descendants.length} child branch(es). Use --force to delete.`);
  }

  // Collect all branches to delete (target + descendants in correct order)
  const branchesToDelete = [...descendants, branch];

  // Stop and remove all containers in parallel
  await Promise.all(
    branchesToDelete.map(async (branchToDelete) => {
      const branchNamespace = parseNamespace(branchToDelete.name);
      const containerName = getContainerName(branchNamespace.project, branchNamespace.branch);

      await withProgress(`Stop container: ${branchToDelete.name}`, async () => {
        const containerID = await docker.getContainerByName(containerName);
        if (containerID) {
          await docker.stopContainer(containerID);
          await docker.removeContainer(containerID);
        }
      });
    })
  );

  // Clean up WAL archives in parallel
  await Promise.all(
    branchesToDelete.map(async (branchToDelete) => {
      const branchNamespace = parseNamespace(branchToDelete.name);
      const datasetName = getDatasetName(branchNamespace.project, branchNamespace.branch);

      await withProgress(`Clean up WAL archive: ${branchToDelete.name}`, async () => {
        await wal.deleteArchiveDir(datasetName);
      });
    })
  );

  // Clean up snapshots from state in parallel
  await Promise.all(
    branchesToDelete.map(async (branchToDelete) => {
      await withProgress(`Clean up snapshots: ${branchToDelete.name}`, async () => {
        await state.snapshots.deleteForBranch(branchToDelete.name);
      });
    })
  );

  // Destroy ZFS datasets sequentially (order matters due to parent-child dependencies)
  for (const branchToDelete of branchesToDelete) {
    const branchNamespace = parseNamespace(branchToDelete.name);
    const datasetName = getDatasetName(branchNamespace.project, branchNamespace.branch);

    await withProgress(`Destroy dataset: ${branchToDelete.name}`, async () => {
      // Only destroy dataset if it exists - this handles cases where previous deletion attempts
      // were interrupted or failed partway through, leaving state entries without actual ZFS datasets
      if (await zfs.datasetExists(datasetName)) {
        await zfs.unmountDataset(datasetName);
        await zfs.destroyDataset(datasetName, true);
      }
    });
  }

  // Remove all branches from state in parallel
  await Promise.all(
    branchesToDelete.map(async (branchToDelete) => {
      await state.branches.delete(project.id, branchToDelete.id);
    })
  );

  console.log();
  console.log(chalk.bold('Branch deleted'));
  console.log();
}
