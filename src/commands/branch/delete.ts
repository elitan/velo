import chalk from 'chalk';
import { UserError } from '../../errors';
import { CLI_NAME } from '../../config/constants';
import { initializeServices, getBranchWithProject } from '../../utils/service-factory';
import { buildBranchTree, renderBranchTree } from '../../utils/tree-renderer';
import type { Branch } from '../../types/state';
import { OperationRunner } from '../../utils/operation-runner';
import { deleteBranches } from '../../services/delete-service';

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
  console.log();
  console.log(`Deleting ${chalk.bold(name)}...`);
  console.log();

  const { state, resources } = await initializeServices();
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
  const operation = new OperationRunner({
    failureMessage: 'Delete failed. Some resources may already be removed.',
  });

  await operation.run(async function runOperation() {
    await deleteBranches({
      operation,
      branches: branchesToDelete,
      projectId: project.id,
      state,
      resources,
    });
  });

  console.log();
  console.log(chalk.bold('Branch deleted'));
  console.log();
}
