import chalk from 'chalk';
import { getContainerName, getDatasetName } from '../../utils/naming';
import { parseNamespace } from '../../utils/namespace';
import { UserError } from '../../errors';
import { withProgress } from '../../utils/progress';
import { CLI_NAME } from '../../config/constants';
import { initializeServices, getProject } from '../../utils/service-factory';
import type { Branch } from '../../types/state';

export async function projectDeleteCommand(name: string, options: { force?: boolean }) {
  console.log();
  console.log(`Deleting project ${chalk.bold(name)}...`);
  console.log();

  const { state, docker, zfs, wal, cert, stateData } = await initializeServices();
  const project = await getProject(state, name);

  // Check if project has non-main branches
  const nonMainBranches = project.branches.filter(b => !b.isPrimary);
  if (nonMainBranches.length > 0 && !options.force) {
    console.log(`Project '${chalk.bold(name)}' has ${nonMainBranches.length} branch(es):`);

    // Build tree structure
    interface BranchNode {
      branch: Branch;
      children: BranchNode[];
    }

    const branchMap = new Map<string, BranchNode>();
    const roots: BranchNode[] = [];

    // Create nodes for all branches (including main for parent lookups)
    for (const branch of project.branches) {
      branchMap.set(branch.id, { branch, children: [] });
    }

    // Build parent-child relationships
    for (const branch of project.branches) {
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

    // Render tree (only non-main branches)
    function renderBranch(node: BranchNode, depth: number = 0) {
      if (!node.branch.isPrimary) {
        const indent = depth > 0 ? '  '.repeat(depth) + '↳ ' : '  ';
        console.log(chalk.dim(`${indent}${node.branch.name}`));
      }
      for (const child of node.children) {
        renderBranch(child, node.branch.isPrimary ? depth : depth + 1);
      }
    }

    for (const root of roots) {
      renderBranch(root, 0);
    }

    console.log();
    console.log(`Use ${chalk.bold('--force')} to delete project and all branches`);
    process.exit(1);
  }

  // Delete all branches (in reverse order for ZFS, but containers can be removed in parallel)
  const branchesToDelete = [...project.branches].reverse();

  // Stop and remove all containers in parallel
  await Promise.all(
    branchesToDelete.map(async (branch) => {
      const namespace = parseNamespace(branch.name);
      const containerName = getContainerName(namespace.project, namespace.branch);

      await withProgress(`Remove branch: ${branch.name}`, async () => {
        const containerID = await docker.getContainerByName(containerName);
        if (containerID) {
          await docker.stopContainer(containerID);
          await docker.removeContainer(containerID);
        }
      });
    })
  );

  // Destroy ZFS datasets for all branches
  await withProgress('Destroy ZFS datasets', async () => {
    for (const branch of branchesToDelete) {
      const namespace = parseNamespace(branch.name);
      const datasetName = getDatasetName(namespace.project, namespace.branch);
      // Only destroy dataset if it exists - this handles cases where previous deletion attempts
      // were interrupted or failed partway through, leaving state entries without actual ZFS datasets
      if (await zfs.datasetExists(datasetName)) {
        await zfs.unmountDataset(datasetName);
        await zfs.destroyDataset(datasetName, true);
      }
    }
  });

  // Clean up WAL archives for all branches in parallel
  await withProgress('Clean up WAL archives', async () => {
    await Promise.all(
      branchesToDelete.map(async (branch) => {
        const namespace = parseNamespace(branch.name);
        const datasetName = getDatasetName(namespace.project, namespace.branch);
        await wal.deleteArchiveDir(datasetName);
      })
    );
  });

  // Clean up SSL certificates
  await withProgress('Clean up SSL certificates', async () => {
    await cert.deleteCerts(project.name);
  });

  // Remove from state
  await state.deleteProject(project.name);

  console.log();
  console.log(chalk.bold(`Project '${name}' deleted`));
  console.log();
}
