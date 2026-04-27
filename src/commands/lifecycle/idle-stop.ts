import Table from 'cli-table3';
import chalk from 'chalk';
import { UserError } from '../../errors';
import { CLI_NAME } from '../../config/constants';
import { getBranchWithProject, initializeServices } from '../../utils/service-factory';
import {
  applyIdleStopPolicy,
  disableIdleStopPolicy,
  enableIdleStopPolicy,
  evaluateIdleStopPolicy,
} from '../../services/idle-stop-service';
import type { Branch, Project } from '../../types/state';

export async function idleStopEnableCommand(name: string, options: { minutes: number }) {
  const minutes = validateMinutes(options.minutes);
  const { state } = await initializeServices();
  const { branch, project } = await getBranchWithProject(state, name);

  await enableIdleStopPolicy(branch, project.id, state, minutes);

  console.log();
  console.log(chalk.bold(`Idle auto-stop enabled for ${name}`));
  console.log(`Threshold: ${minutes} minute(s)`);
  console.log();
}

export async function idleStopDisableCommand(name: string) {
  const { state } = await initializeServices();
  const { branch, project } = await getBranchWithProject(state, name);

  await disableIdleStopPolicy(branch, project.id, state);

  console.log();
  console.log(chalk.bold(`Idle auto-stop disabled for ${name}`));
  console.log();
}

export async function idleStopListCommand() {
  const { state } = await initializeServices();
  const projects = state.projects.list();

  console.log();
  console.log(chalk.bold('Idle Auto-Stop Policies'));
  console.log();

  const table = new Table({
    head: ['Branch', 'Enabled', 'Threshold', 'Last active', 'Stopped reason'],
    style: {
      head: [],
      border: ['gray'],
    },
  });

  for (const project of projects) {
    for (const branch of project.branches) {
      table.push([
        branch.name,
        branch.idleStop?.enabled ? 'yes' : 'no',
        branch.idleStop?.enabled ? `${branch.idleStop.idleMinutes}m` : chalk.dim('—'),
        branch.idleStop?.lastActiveAt || chalk.dim('—'),
        branch.idleStop?.stoppedReason || chalk.dim('—'),
      ]);
    }
  }

  console.log(table.toString());
  console.log();
}

export async function idleStopRunCommand(name: string | undefined, options: { dryRun?: boolean } = {}) {
  const { state, docker } = await initializeServices();
  const targets: Array<{ branch: Branch; project: Project }> = [];

  if (name) {
    targets.push(await getBranchWithProject(state, name));
  } else {
    for (const project of state.projects.list()) {
      for (const branch of project.branches) {
        if (branch.idleStop?.enabled) {
          targets.push({ branch, project });
        }
      }
    }
  }

  console.log();
  console.log(chalk.bold(options.dryRun ? 'Idle Auto-Stop Dry Run' : 'Idle Auto-Stop Run'));
  console.log();

  if (targets.length === 0) {
    console.log(chalk.dim(`No enabled idle auto-stop policies. Run ${CLI_NAME} lifecycle idle-stop enable <branch>.`));
    console.log();
    return;
  }

  const table = new Table({
    head: ['Branch', 'Action', 'Idle', 'Message'],
    style: {
      head: [],
      border: ['gray'],
    },
  });

  for (const target of targets) {
    const result = options.dryRun
      ? await evaluateIdleStopPolicy(target.branch, docker)
      : await applyIdleStopPolicy(target.branch, target.project.id, state, docker);

    table.push([
      target.branch.name,
      options.dryRun && result.action === 'stopped' ? 'would-stop' : result.action,
      result.idleMinutes === undefined ? chalk.dim('—') : `${result.idleMinutes}m`,
      result.message,
    ]);
  }

  console.log(table.toString());
  console.log();
}

function validateMinutes(minutes: number): number {
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new UserError('Idle minutes must be a positive integer');
  }

  return minutes;
}
