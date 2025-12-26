import Table from 'cli-table3';
import chalk from 'chalk';
import { formatBytes } from '../../utils/helpers';
import { getDatasetName } from '../../utils/naming';
import { parseNamespace } from '../../utils/namespace';
import { UserError } from '../../errors';
import { CLI_NAME } from '../../config/constants';
import { initializeServices } from '../../utils/service-factory';
import { buildBranchTree, traverseBranchTree, getTreeIndent } from '../../utils/tree-renderer';

export async function branchListCommand(projectName?: string) {
  const { state, zfs } = await initializeServices();

  const projects = state.projects.list();

  // Filter by project if specified
  const filtered = projectName
    ? projects.filter(proj => proj.name === projectName)
    : projects;

  if (filtered.length === 0) {
    if (projectName) {
      throw new UserError(
        `Project '${projectName}' not found`,
        `Run '${CLI_NAME} project list' to see available projects`
      );
    } else {
      console.log();
      console.log(chalk.dim(`No projects found. Create one with: ${CLI_NAME} project create <name>`));
      console.log();
      return;
    }
  }

  // Create table
  const table = new Table({
    head: ['', 'Branch', 'Status', 'Port', 'Size'],
    style: {
      head: [],
      border: ['gray']
    }
  });

  // Process each project
  for (const proj of filtered) {
    const { roots } = buildBranchTree(proj.branches);

    await traverseBranchTree(roots, async (node, depth) => {
      const branch = node.branch;
      const statusIcon = branch.status === 'running' ? '●' : '';
      const statusText = branch.status === 'running' ? 'running' : 'stopped';
      const port = branch.status === 'running' ? branch.port.toString() : '-';

      // Build name with tree structure
      const indent = depth > 0 ? getTreeIndent(depth).slice(2) : '';
      const namespace = parseNamespace(branch.name);
      const displayName = depth > 0 ? namespace.branch : branch.name;
      const name = indent + displayName;
      const type = branch.isPrimary ? chalk.dim(' (main)') : '';

      // Query size on-demand from ZFS
      const datasetName = getDatasetName(namespace.project, namespace.branch);
      let sizeBytes = 0;
      try {
        sizeBytes = await zfs.getUsedSpace(datasetName);
      } catch {
        // If dataset doesn't exist, show 0
      }

      table.push([
        statusIcon,
        name + type,
        statusText,
        port,
        formatBytes(sizeBytes)
      ]);
    });
  }

  console.log();
  console.log(table.toString());
  console.log();
}
