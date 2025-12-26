import Table from 'cli-table3';
import chalk from 'chalk';
import { CLI_NAME } from '../../config/constants';
import { initializeServices } from '../../utils/service-factory';

export async function projectListCommand() {
  const { state } = await initializeServices();

  const projects = state.projects.list();

  if (projects.length === 0) {
    console.log(chalk.dim(`No projects found. Create one with: ${CLI_NAME} project create <name>`));
    return;
  }

  const table = new Table({
    head: ['Name', 'Branches', 'Running', 'Image'],
    style: {
      head: [],
      border: ['gray']
    }
  });

  for (const proj of projects) {
    const totalBranches = proj.branches.length;
    const runningBranches = proj.branches.filter(b => b.status === 'running').length;

    table.push([
      chalk.bold(proj.name),
      totalBranches.toString(),
      `${runningBranches}/${totalBranches}`,
      chalk.dim(proj.dockerImage)
    ]);
  }

  console.log();
  console.log(table.toString());
  console.log();
}
