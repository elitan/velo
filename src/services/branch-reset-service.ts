import type { ZFSManager } from '../managers/zfs';
import type { OperationRunner } from '../utils/operation-runner';
import type { ResourceService } from './resource-service';

type ResetZfs = Pick<ZFSManager, 'cloneSnapshot' | 'mountDataset' | 'unmountDataset' | 'renameDataset'>;
type ResetResources = Pick<ResourceService, 'destroyDataset'>;

export interface ReplaceBranchDatasetOptions {
  operation: OperationRunner;
  zfs: ResetZfs;
  resources: ResetResources;
  fullSnapshotName: string;
  datasetName: string;
  tempDatasetName: string;
  backupDatasetName: string;
}

export async function replaceBranchDataset(options: ReplaceBranchDatasetOptions): Promise<void> {
  const {
    operation,
    zfs,
    resources,
    fullSnapshotName,
    datasetName,
    tempDatasetName,
    backupDatasetName,
  } = options;

  await operation.step('Clone new snapshot', async function cloneDataset() {
    await zfs.cloneSnapshot(fullSnapshotName, tempDatasetName);
  }, async function rollbackTempDataset() {
    await resources.destroyDataset(tempDatasetName);
  });

  await operation.step('Mount temp dataset', async function mountTempDataset() {
    await zfs.mountDataset(tempDatasetName);
  });

  await operation.step('Unmount current dataset', async function unmountCurrentDataset() {
    await zfs.unmountDataset(datasetName);
  }, async function rollbackCurrentMount() {
    await zfs.mountDataset(datasetName);
  });

  await operation.step('Move current dataset aside', async function moveCurrentDatasetAside() {
    await zfs.renameDataset(datasetName, backupDatasetName);
  }, async function rollbackCurrentDatasetName() {
    await zfs.renameDataset(backupDatasetName, datasetName);
  });

  await operation.step('Unmount temp dataset', async function unmountTempDataset() {
    await zfs.unmountDataset(tempDatasetName);
  });

  await operation.step('Move new dataset into place', async function moveNewDatasetIntoPlace() {
    await zfs.renameDataset(tempDatasetName, datasetName);
  }, async function rollbackNewDatasetName() {
    await zfs.unmountDataset(datasetName).catch(function ignoreError() {});
    await zfs.renameDataset(datasetName, tempDatasetName);
  });

  await operation.step('Mount dataset', async function mountDataset() {
    await zfs.mountDataset(datasetName);
  });
}
