import chalk from 'chalk';
import { getContainerName } from '../utils/naming';
import { parseNamespace } from '../utils/namespace';
import { UserError } from '../errors';
import { withProgress } from '../utils/progress';
import { CLI_NAME } from '../config/constants';
import { initializeServices } from '../utils/service-factory';

export async function stopCommand(name: string) {
  const namespace = parseNamespace(name);

  const { state, docker } = await initializeServices();

  // Look up branch by namespaced name
  const branchResult = state.branches.getByNamespace(name);

  if (!branchResult) {
    throw new UserError(
      `Branch '${name}' not found`,
      `Run '${CLI_NAME} branch list' to see available branches`
    );
  }

  const { branch, project } = branchResult;

  if (branch.status === 'stopped') {
    console.log();
    console.log(chalk.dim(`Branch '${name}' is already stopped`));
    console.log();
    return;
  }

  console.log();
  console.log(`Stopping ${chalk.bold(name)}...`);
  console.log();

  const containerName = getContainerName(namespace.project, namespace.branch);
  const containerID = await docker.getContainerByName(containerName);
  if (!containerID) {
    throw new UserError(`Container '${containerName}' not found`);
  }

  await withProgress('Stop container', async () => {
    await docker.stopContainer(containerID);
  });

  // Update state
  branch.status = 'stopped';
  await state.branches.update(project.id, branch);

  console.log();
  console.log(chalk.bold('Branch stopped'));
  console.log();
}
