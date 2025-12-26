import chalk from 'chalk';
import { getContainerName } from '../utils/naming';
import { parseNamespace } from '../utils/namespace';
import { UserError } from '../errors';
import { withProgress } from '../utils/progress';
import { getPublicIP, formatConnectionString } from '../utils/network';
import { CLI_NAME } from '../config/constants';
import { initializeServices } from '../utils/service-factory';

export async function restartCommand(name: string) {
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

  console.log();
  console.log(`Restarting ${chalk.bold(name)}...`);
  console.log();

  const containerName = getContainerName(namespace.project, namespace.branch);
  const containerID = await docker.getContainerByName(containerName);
  if (!containerID) {
    throw new UserError(`Container '${containerName}' not found`);
  }

  await withProgress('Restart container', async () => {
    await docker.restartContainer(containerID);
  });

  await withProgress('PostgreSQL ready', async () => {
    await docker.waitForHealthy(containerID);
  });

  // Get the actual port (Docker may reassign on restart)
  const actualPort = await docker.getContainerPort(containerID);

  branch.status = 'running';
  branch.port = actualPort;
  await state.branches.update(project.id, branch);

  // Get public IP for remote connection info
  const publicIP = await getPublicIP();

  console.log();
  console.log(chalk.bold('Branch restarted'));
  console.log();
  console.log(chalk.bold('Connection:'));
  console.log(formatConnectionString(
    project.credentials.username,
    project.credentials.password,
    actualPort,
    project.credentials.database,
    publicIP
  ));
  console.log();
}
