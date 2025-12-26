import Table from 'cli-table3';
import chalk from 'chalk';
import { formatBytes } from '../../utils/helpers';
import { UserError } from '../../errors';
import { CLI_NAME } from '../../config/constants';
import { initializeServices } from '../../utils/service-factory';

export async function projectGetCommand(name: string) {
  const { state } = await initializeServices();

  const project = state.projects.getByName(name);
  if (!project) {
    throw new UserError(
      `Project '${name}' not found`,
      `Run '${CLI_NAME} project list' to see available projects`
    );
  }

  console.log();
  console.log(chalk.bold(`Project: ${name}`));
  console.log();

  // Project info
  const infoTable = new Table({
    style: {
      border: ['gray']
    }
  });

  infoTable.push(
    ['ID', project.id],
    ['Name', project.name],
    ['Docker Image', project.dockerImage],
    ['Created', new Date(project.createdAt).toLocaleString()],
    ['Branches', project.branches.length.toString()]
  );

  console.log(infoTable.toString());
  console.log();

  // Branches table
  console.log(chalk.bold('Branches:'));
  console.log();

  const branchTable = new Table({
    head: ['Name', 'Type', 'Status', 'Port', 'Size'],
    style: {
      head: [],
      border: ['gray']
    }
  });

  for (const branch of project.branches) {
    const branchName = branch.name.split('/')[1]; // Get branch name without project prefix
    const type = branch.isPrimary ? 'main' : 'branch';
    const status = branch.status === 'running' ? 'running' : 'stopped';

    branchTable.push([
      branch.isPrimary ? chalk.bold(branchName) : branchName,
      type,
      status,
      branch.port.toString(),
      formatBytes(branch.sizeBytes)
    ]);
  }

  console.log(branchTable.toString());
  console.log();

  // Connection details
  console.log(chalk.bold('Connection:'));
  console.log(chalk.dim('  Username:'), project.credentials.username);
  console.log(chalk.dim('  Database:'), project.credentials.database);
  console.log();
}
