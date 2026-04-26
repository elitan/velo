import { describe, expect, test } from 'bun:test';
import { getBranchContainerName, getContainerName, getDatasetName, getDatasetPathFromName, getLegacyContainerName } from './naming';
import type { Branch } from '../types/state';

function branch(overrides: Partial<Branch>): Branch {
  return {
    id: 'branch-id',
    name: 'api/dev',
    projectName: 'api',
    parentBranchId: null,
    isPrimary: false,
    snapshotName: null,
    zfsDataset: 'api.dev',
    port: 5432,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
    ...overrides,
  };
}

describe('resource naming', () => {
  test('uses names that do not collide when project and branch names contain hyphens', () => {
    expect(getDatasetName('foo-bar', 'baz')).toBe('foo-bar.baz');
    expect(getDatasetName('foo', 'bar-baz')).toBe('foo.bar-baz');
    expect(getDatasetName('foo-bar', 'baz')).not.toBe(getDatasetName('foo', 'bar-baz'));
  });

  test('uses the stored container name when state has one', () => {
    const item = branch({ containerName: 'velo-api.dev' });
    expect(getBranchContainerName(item)).toBe('velo-api.dev');
  });

  test('falls back to legacy container names for old state', () => {
    const item = branch({ containerName: undefined, name: 'api/dev' });
    expect(getBranchContainerName(item)).toBe(getLegacyContainerName('api', 'dev'));
  });

  test('builds full dataset paths from stored dataset names', () => {
    expect(getDatasetPathFromName('tank', 'velo/databases', 'api.dev')).toBe('tank/velo/databases/api.dev');
    expect(getContainerName('api', 'dev')).toBe('velo-api.dev');
  });
});
