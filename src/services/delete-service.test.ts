import { describe, expect, test } from 'bun:test';
import { deleteBranches, deleteProject } from './delete-service';
import { OperationRunner } from '../utils/operation-runner';
import type { Branch, Project } from '../types/state';

function createOperationRunner(labels: string[]): OperationRunner {
  return new OperationRunner({
    runStep: async function runStep<T>(label: string, operation: () => Promise<T>): Promise<T> {
      labels.push(label);
      return await operation();
    },
    writeMessage: function writeMessage() {},
    writeRollbackError: function writeRollbackError() {},
    writeRollbackSummary: function writeRollbackSummary() {},
  });
}

function branch(name: string, id = name): Branch {
  const branchName = name.split('/')[1]!;

  return {
    id,
    name,
    projectName: name.split('/')[0]!,
    parentBranchId: null,
    isPrimary: branchName === 'main',
    snapshotName: null,
    zfsDataset: name.replace('/', '.'),
    containerName: `velo-${name.replace('/', '.')}`,
    port: 5432,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
  };
}

function project(branches: Branch[]): Project {
  return {
    id: 'project-1',
    name: 'api',
    dockerImage: 'postgres:17-alpine',
    sslCertDir: '/tmp/certs',
    createdAt: '2026-01-01T00:00:00.000Z',
    credentials: {
      username: 'postgres',
      password: 'secret',
      database: 'postgres',
    },
    branches,
  };
}

function createFakes(): {
  calls: string[];
  state: any;
  resources: any;
  cert: any;
} {
  const calls: string[] = [];

  return {
    calls,
    state: {
      snapshots: {
        async deleteForBranch(branchName: string): Promise<void> {
          calls.push(`snapshots:${branchName}`);
        },
      },
      branches: {
        async delete(projectId: string, branchId: string): Promise<void> {
          calls.push(`branch-state:${projectId}:${branchId}`);
        },
      },
      projects: {
        async delete(projectName: string): Promise<void> {
          calls.push(`project-state:${projectName}`);
        },
      },
    },
    resources: {
      async stopAndRemoveBranchContainer(item: Branch): Promise<boolean> {
        calls.push(`container:${item.name}`);
        return true;
      },
      async deleteBranchWalArchive(item: Branch): Promise<void> {
        calls.push(`wal:${item.name}`);
      },
      async destroyBranchDataset(item: Branch): Promise<boolean> {
        calls.push(`dataset:${item.name}`);
        return true;
      },
    },
    cert: {
      async deleteCerts(projectName: string): Promise<void> {
        calls.push(`certs:${projectName}`);
      },
    },
  };
}

describe('deleteBranches', function () {
  test('deletes branch resources before branch state', async function () {
    const labels: string[] = [];
    const operation = createOperationRunner(labels);
    const { calls, state, resources } = createFakes();
    const child = branch('api/child', 'child-id');
    const parent = branch('api/parent', 'parent-id');

    await operation.run(async function runOperation() {
      await deleteBranches({
        operation,
        branches: [child, parent],
        projectId: 'project-1',
        state,
        resources,
      });
    });

    expect(labels).toEqual([
      'Stop container: api/child',
      'Stop container: api/parent',
      'Clean up WAL archive: api/child',
      'Clean up WAL archive: api/parent',
      'Clean up snapshots: api/child',
      'Clean up snapshots: api/parent',
      'Destroy dataset: api/child',
      'Destroy dataset: api/parent',
      'Remove branch state: api/child',
      'Remove branch state: api/parent',
    ]);
    expect(calls).toEqual([
      'container:api/child',
      'container:api/parent',
      'wal:api/child',
      'wal:api/parent',
      'snapshots:api/child',
      'snapshots:api/parent',
      'dataset:api/child',
      'dataset:api/parent',
      'branch-state:project-1:child-id',
      'branch-state:project-1:parent-id',
    ]);
  });
});

describe('deleteProject', function () {
  test('deletes project resources and project snapshot state', async function () {
    const labels: string[] = [];
    const operation = createOperationRunner(labels);
    const { calls, state, resources, cert } = createFakes();
    const main = branch('api/main', 'main-id');
    const dev = branch('api/dev', 'dev-id');

    await operation.run(async function runOperation() {
      await deleteProject({
        operation,
        project: project([main, dev]),
        state,
        resources,
        cert,
      });
    });

    expect(labels).toEqual([
      'Remove branch: api/dev',
      'Remove branch: api/main',
      'Destroy ZFS datasets',
      'Clean up WAL archives',
      'Clean up snapshots',
      'Clean up SSL certificates',
      'Remove project state',
    ]);
    expect(calls).toEqual([
      'container:api/dev',
      'container:api/main',
      'dataset:api/dev',
      'dataset:api/main',
      'wal:api/dev',
      'wal:api/main',
      'snapshots:api/dev',
      'snapshots:api/main',
      'certs:api',
      'project-state:api',
    ]);
  });
});
