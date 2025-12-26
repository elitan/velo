import chalk from 'chalk';
import type { Branch } from '../types/state';

/**
 * Node in a branch tree structure
 */
export interface BranchNode {
  branch: Branch;
  children: BranchNode[];
}

/**
 * Result of building a branch tree
 */
export interface BranchTree {
  roots: BranchNode[];
  nodeMap: Map<string, BranchNode>;
}

/**
 * Options for rendering a branch tree
 */
export interface RenderOptions {
  /** Skip rendering nodes matching this predicate (children still rendered) */
  skip?: (branch: Branch) => boolean;
  /** Custom formatter for branch display (default: chalk.dim with name) */
  format?: (branch: Branch, indent: string) => string;
}

/**
 * Build a tree structure from a flat list of branches
 */
export function buildBranchTree(branches: Branch[]): BranchTree {
  const nodeMap = new Map<string, BranchNode>();
  const roots: BranchNode[] = [];

  // Create nodes for all branches
  for (const branch of branches) {
    nodeMap.set(branch.id, { branch, children: [] });
  }

  // Build parent-child relationships
  for (const branch of branches) {
    const node = nodeMap.get(branch.id)!;
    if (branch.parentBranchId) {
      const parent = nodeMap.get(branch.parentBranchId);
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    } else {
      roots.push(node);
    }
  }

  return { roots, nodeMap };
}

/**
 * Get tree indent string for a given depth
 */
export function getTreeIndent(depth: number): string {
  return depth > 0 ? '  '.repeat(depth) + '↳ ' : '  ';
}

/**
 * Render a branch tree to console
 */
export function renderBranchTree(
  roots: BranchNode[],
  options: RenderOptions = {}
): void {
  const { skip, format } = options;

  function renderNode(node: BranchNode, depth: number): void {
    const shouldSkip = skip?.(node.branch) ?? false;

    if (!shouldSkip) {
      const indent = getTreeIndent(depth);
      const line = format
        ? format(node.branch, indent)
        : chalk.dim(`${indent}${node.branch.name}`);
      console.log(line);
    }

    // Render children (adjust depth if we skipped this node)
    for (const child of node.children) {
      renderNode(child, shouldSkip ? depth : depth + 1);
    }
  }

  for (const root of roots) {
    renderNode(root, 0);
  }
}

/**
 * Traverse a branch tree in depth-first order, calling visitor for each node
 * Async visitor support for operations like fetching ZFS data
 */
export async function traverseBranchTree<T>(
  roots: BranchNode[],
  visitor: (node: BranchNode, depth: number) => Promise<T> | T
): Promise<T[]> {
  const results: T[] = [];

  async function traverse(node: BranchNode, depth: number): Promise<void> {
    results.push(await visitor(node, depth));
    for (const child of node.children) {
      await traverse(child, depth + 1);
    }
  }

  for (const root of roots) {
    await traverse(root, 0);
  }

  return results;
}
