import { describe, expect, test } from 'bun:test';
import { replaceBranchDataset } from './branch-reset-service';
import { OperationRunner } from '../utils/operation-runner';

function createOperationRunner(): OperationRunner {
  return new OperationRunner({
    runStep: async function runStep<T>(_label: string, operation: () => Promise<T>): Promise<T> {
      return await operation();
    },
    writeMessage: function writeMessage() {},
    writeRollbackError: function writeRollbackError() {},
    writeRollbackSummary: function writeRollbackSummary() {},
  });
}

function createFakes(failOnCall?: string): {
  calls: string[];
  zfs: any;
  resources: any;
} {
  const calls: string[] = [];

  function record(call: string): void {
    calls.push(call);

    if (call === failOnCall) {
      throw new Error(`failed: ${call}`);
    }
  }

  return {
    calls,
    zfs: {
      async cloneSnapshot(snapshot: string, target: string): Promise<void> {
        record(`clone:${snapshot}->${target}`);
      },
      async mountDataset(name: string): Promise<void> {
        record(`mount:${name}`);
      },
      async unmountDataset(name: string): Promise<void> {
        record(`unmount:${name}`);
      },
      async renameDataset(from: string, to: string): Promise<void> {
        record(`rename:${from}->${to}`);
      },
    },
    resources: {
      async destroyDataset(name: string): Promise<boolean> {
        record(`destroy:${name}`);
        return true;
      },
    },
  };
}

describe('replaceBranchDataset', function () {
  test('swaps the reset dataset through temp and backup names', async function () {
    const { calls, zfs, resources } = createFakes();
    const operation = createOperationRunner();

    await operation.run(async function runOperation() {
      await replaceBranchDataset({
        operation,
        zfs,
        resources,
        fullSnapshotName: 'tank/velo/api.main@snap',
        datasetName: 'api.dev',
        tempDatasetName: 'api.dev-temp',
        backupDatasetName: 'api.dev-old',
      });
    });

    expect(calls).toEqual([
      'clone:tank/velo/api.main@snap->api.dev-temp',
      'mount:api.dev-temp',
      'unmount:api.dev',
      'rename:api.dev->api.dev-old',
      'unmount:api.dev-temp',
      'rename:api.dev-temp->api.dev',
      'mount:api.dev',
    ]);
  });

  test('restores the original dataset when a later step fails', async function () {
    const { calls, zfs, resources } = createFakes();
    const operation = createOperationRunner();

    await expect(operation.run(async function runOperation() {
      await replaceBranchDataset({
        operation,
        zfs,
        resources,
        fullSnapshotName: 'tank/velo/api.main@snap',
        datasetName: 'api.dev',
        tempDatasetName: 'api.dev-temp',
        backupDatasetName: 'api.dev-old',
      });

      throw new Error('later failure');
    })).rejects.toThrow('later failure');

    expect(calls).toEqual([
      'clone:tank/velo/api.main@snap->api.dev-temp',
      'mount:api.dev-temp',
      'unmount:api.dev',
      'rename:api.dev->api.dev-old',
      'unmount:api.dev-temp',
      'rename:api.dev-temp->api.dev',
      'mount:api.dev',
      'unmount:api.dev',
      'rename:api.dev->api.dev-temp',
      'rename:api.dev-old->api.dev',
      'mount:api.dev',
      'destroy:api.dev-temp',
    ]);
  });

  test('restores the original dataset when swap fails after moving it aside', async function () {
    const { calls, zfs, resources } = createFakes('unmount:api.dev-temp');
    const operation = createOperationRunner();

    await expect(operation.run(async function runOperation() {
      await replaceBranchDataset({
        operation,
        zfs,
        resources,
        fullSnapshotName: 'tank/velo/api.main@snap',
        datasetName: 'api.dev',
        tempDatasetName: 'api.dev-temp',
        backupDatasetName: 'api.dev-old',
      });
    })).rejects.toThrow('failed: unmount:api.dev-temp');

    expect(calls).toEqual([
      'clone:tank/velo/api.main@snap->api.dev-temp',
      'mount:api.dev-temp',
      'unmount:api.dev',
      'rename:api.dev->api.dev-old',
      'unmount:api.dev-temp',
      'rename:api.dev-old->api.dev',
      'mount:api.dev',
      'destroy:api.dev-temp',
    ]);
  });
});
