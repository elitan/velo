import Table from 'cli-table3';
import chalk from 'chalk';
import { StateManager } from '../../managers/state';
import { ZFSManager } from '../../managers/zfs';
import { PATHS } from '../../utils/paths';
import { formatBytes } from '../../utils/helpers';
import { getDatasetName } from '../../utils/naming';
import { parseNamespace } from '../../utils/namespace';
import { UserError } from '../../errors';
import { CLI_NAME } from '../../config/constants';

export async function branchListCommand(projectName?: string) {
  const state = new StateManager(PATHS.STATE);
  await state.load();

  const stateData = state.getState();
  const zfs = new ZFSManager(stateData.zfsPool, stateData.zfsDatasetBase);

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

  // Helper to build tree and render branches
  interface BranchNode {
    branch: any;
    children: BranchNode[];
  }

  async function renderBranch(node: BranchNode, depth: number = 0) {
    const branch = node.branch;
    const statusIcon = branch.status === 'running' ? '●' : '';
    const statusText = branch.status === 'running' ? 'running' : 'stopped';
    const port = branch.status === 'running' ? branch.port.toString() : '-';

    // Build name with tree structure
    const indent = depth > 0 ? '  '.repeat(depth) + '↳ ' : '';
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

    // Render children
    for (const child of node.children) {
      await renderBranch(child, depth + 1);
    }
  }

  // Process each project
  for (const proj of filtered) {
    // Build tree structure
    const branchMap = new Map<string, BranchNode>();
    const roots: BranchNode[] = [];

    // Create nodes for all branches
    for (const branch of proj.branches) {
      branchMap.set(branch.id, { branch, children: [] });
    }

    // Build parent-child relationships
    for (const branch of proj.branches) {
      const node = branchMap.get(branch.id)!;
      if (branch.parentBranchId) {
        const parent = branchMap.get(branch.parentBranchId);
        if (parent) {
          parent.children.push(node);
        } else {
          roots.push(node);
        }
      } else {
        roots.push(node);
      }
    }

    // Render tree
    for (const root of roots) {
      await renderBranch(root, 0);
    }
  }

  console.log();
  console.log(table.toString());
  console.log();
}
