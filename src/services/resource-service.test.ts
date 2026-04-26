import { describe, expect, test } from 'bun:test';
import { ResourceService } from './resource-service';
import type { Branch } from '../types/state';
import type { DockerManager } from '../managers/docker';
import type { ZFSManager } from '../managers/zfs';
import type { WALManager } from '../managers/wal';

class FakeDocker {
  containers = new Map<string, string>();
  calls: string[] = [];
  stopError: any = null;

  async getContainerByName(name: string): Promise<string | null> {
    this.calls.push(`get:${name}`);
    return this.containers.get(name) || null;
  }

  async stopContainer(id: string): Promise<void> {
    this.calls.push(`stop:${id}`);
    if (this.stopError) {
      throw this.stopError;
    }
  }

  async removeContainer(id: string): Promise<void> {
    this.calls.push(`remove:${id}`);
  }
}

class FakeZFS {
  datasets = new Set<string>();
  calls: string[] = [];

  async datasetExists(name: string): Promise<boolean> {
    this.calls.push(`exists:${name}`);
    return this.datasets.has(name);
  }

  async unmountDataset(name: string): Promise<void> {
    this.calls.push(`unmount:${name}`);
  }

  async destroyDataset(name: string, recursive: boolean): Promise<void> {
    this.calls.push(`destroy:${name}:${recursive}`);
  }
}

class FakeWAL {
  calls: string[] = [];

  async deleteArchiveDir(datasetName: string): Promise<void> {
    this.calls.push(`delete:${datasetName}`);
  }

  async ensureArchiveDir(datasetName: string): Promise<void> {
    this.calls.push(`ensure:${datasetName}`);
  }

  getArchivePath(datasetName: string): string {
    this.calls.push(`path:${datasetName}`);
    return `/wal/${datasetName}`;
  }
}

function createBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    id: 'branch-id',
    name: 'api/dev',
    projectName: 'api',
    parentBranchId: null,
    isPrimary: false,
    snapshotName: null,
    zfsDataset: 'api.dev',
    containerName: 'velo-api.dev',
    port: 5432,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
    ...overrides,
  };
}

function createService(): {
  service: ResourceService;
  docker: FakeDocker;
  zfs: FakeZFS;
  wal: FakeWAL;
} {
  const docker = new FakeDocker();
  const zfs = new FakeZFS();
  const wal = new FakeWAL();
  const service = new ResourceService(
    docker as unknown as DockerManager,
    zfs as unknown as ZFSManager,
    wal as unknown as WALManager
  );

  return { service, docker, zfs, wal };
}

describe('ResourceService', function () {
  test('stops and removes an existing branch container', async function () {
    const { service, docker } = createService();
    docker.containers.set('velo-api.dev', 'container-id');

    const removed = await service.stopAndRemoveBranchContainer(createBranch());

    expect(removed).toBe(true);
    expect(docker.calls).toEqual([
      'get:velo-api.dev',
      'stop:container-id',
      'remove:container-id',
    ]);
  });

  test('returns false when the container does not exist', async function () {
    const { service, docker } = createService();

    const removed = await service.stopAndRemoveContainer('velo-api.dev');

    expect(removed).toBe(false);
    expect(docker.calls).toEqual(['get:velo-api.dev']);
  });

  test('removes an already stopped container', async function () {
    const { service, docker } = createService();
    docker.containers.set('velo-api.dev', 'container-id');
    docker.stopError = { statusCode: 304 };

    const removed = await service.stopAndRemoveContainer('velo-api.dev');

    expect(removed).toBe(true);
    expect(docker.calls).toEqual([
      'get:velo-api.dev',
      'stop:container-id',
      'remove:container-id',
    ]);
  });

  test('destroys an existing branch dataset', async function () {
    const { service, zfs } = createService();
    zfs.datasets.add('api.dev');

    const destroyed = await service.destroyBranchDataset(createBranch());

    expect(destroyed).toBe(true);
    expect(zfs.calls).toEqual([
      'exists:api.dev',
      'unmount:api.dev',
      'destroy:api.dev:true',
    ]);
  });

  test('returns false when the dataset does not exist', async function () {
    const { service, zfs } = createService();

    const destroyed = await service.destroyDataset('api.dev');

    expect(destroyed).toBe(false);
    expect(zfs.calls).toEqual(['exists:api.dev']);
  });

  test('recreates WAL archive and returns its path', async function () {
    const { service, wal } = createService();

    const path = await service.recreateWalArchive('api.dev');

    expect(path).toBe('/wal/api.dev');
    expect(wal.calls).toEqual([
      'delete:api.dev',
      'ensure:api.dev',
      'path:api.dev',
    ]);
  });
});
