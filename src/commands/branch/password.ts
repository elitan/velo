import chalk from 'chalk';
import { StateManager } from '../../managers/state';
import { PATHS } from '../../utils/paths';
import { parseNamespace } from '../../utils/namespace';
import { UserError } from '../../errors';
import { getPublicIP, formatConnectionString } from '../../utils/network';
import { CLI_NAME } from '../../config/constants';

export async function branchPasswordCommand(name: string) {
  const namespace = parseNamespace(name);

  const state = new StateManager(PATHS.STATE);
  await state.load();

  const result = state.branches.getByNamespace(name);
  if (!result) {
    throw new UserError(
      `Branch '${name}' not found`,
      `Run '${CLI_NAME} branch list' to see available branches`
    );
  }

  const { branch, project } = result;

  // Get public IP for remote connection info
  const publicIP = await getPublicIP();

  console.log();
  console.log(chalk.bold(`Connection details for ${name}`));
  console.log();
  console.log(chalk.dim('  Host:    '), 'localhost');
  console.log(chalk.dim('  Port:    '), branch.port);
  console.log(chalk.dim('  Database:'), project.credentials.database);
  console.log(chalk.dim('  Username:'), project.credentials.username);
  console.log(chalk.dim('  Password:'), project.credentials.password);
  console.log();
  console.log(chalk.bold('Connection:'));
  console.log(formatConnectionString(
    project.credentials.username,
    project.credentials.password,
    branch.port,
    project.credentials.database,
    publicIP
  ));
  console.log();
}
