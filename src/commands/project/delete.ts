import chalk from 'chalk';
import { UserError } from '../../errors';
import { withProgress } from '../../utils/progress';
import { CLI_NAME } from '../../config/constants';
import { initializeServices, getProject } from '../../utils/service-factory';
import { buildBranchTree, renderBranchTree } from '../../utils/tree-renderer';

export async function projectDeleteCommand(name: string, options: { force?: boolean }) {
  console.log();
  console.log(`Deleting project ${chalk.bold(name)}...`);
  console.log();

  const { state, resources, cert } = await initializeServices();
  const project = await getProject(state, name);

  // Check if project has non-main branches
  const nonMainBranches = project.branches.filter(b => !b.isPrimary);
  if (nonMainBranches.length > 0 && !options.force) {
    console.log(`Project '${chalk.bold(name)}' has ${nonMainBranches.length} branch(es):`);

    // Build and render tree (skip main branch)
    const { roots } = buildBranchTree(project.branches);
    renderBranchTree(roots, {
      skip: (branch) => branch.isPrimary,
    });

    console.log();
    console.log(`Use ${chalk.bold('--force')} to delete project and all branches`);

    throw new UserError(`Project '${name}' has ${nonMainBranches.length} branch(es). Use --force to delete.`);
  }

  // Delete all branches (in reverse order for ZFS, but containers can be removed in parallel)
  const branchesToDelete = [...project.branches].reverse();

  // Stop and remove all containers in parallel
  await Promise.all(
    branchesToDelete.map(async (branch) => {
      await withProgress(`Remove branch: ${branch.name}`, async () => {
        await resources.stopAndRemoveBranchContainer(branch);
      });
    })
  );

  // Destroy ZFS datasets for all branches
  await withProgress('Destroy ZFS datasets', async () => {
    for (const branch of branchesToDelete) {
      await resources.destroyBranchDataset(branch);
    }
  });

  // Clean up WAL archives for all branches in parallel
  await withProgress('Clean up WAL archives', async () => {
    await Promise.all(
      branchesToDelete.map(async (branch) => {
        await resources.deleteBranchWalArchive(branch);
      })
    );
  });

  // Clean up SSL certificates
  await withProgress('Clean up SSL certificates', async () => {
    await cert.deleteCerts(project.name);
  });

  // Remove from state
  await state.projects.delete(project.name);

  console.log();
  console.log(chalk.bold(`Project '${name}' deleted`));
  console.log();
}
