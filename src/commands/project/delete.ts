import chalk from 'chalk';
import { UserError } from '../../errors';
import { CLI_NAME } from '../../config/constants';
import { initializeServices, getProject } from '../../utils/service-factory';
import { buildBranchTree, renderBranchTree } from '../../utils/tree-renderer';
import { OperationRunner } from '../../utils/operation-runner';
import { deleteProject } from '../../services/delete-service';

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

  const operation = new OperationRunner({
    failureMessage: 'Delete failed. Some resources may already be removed.',
  });

  await operation.run(async function runOperation() {
    await deleteProject({
      operation,
      project,
      state,
      resources,
      cert,
    });
  });

  console.log();
  console.log(chalk.bold(`Project '${name}' deleted`));
  console.log();
}
