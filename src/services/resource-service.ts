import type { Branch } from '../types/state';
import { DockerManager } from '../managers/docker';
import { ZFSManager } from '../managers/zfs';
import { WALManager } from '../managers/wal';
import { getBranchContainerName } from '../utils/naming';

export class ResourceService {
  constructor(
    private docker: DockerManager,
    private zfs: ZFSManager,
    private wal: WALManager
  ) {}

  getBranchContainerName(branch: Branch): string {
    return getBranchContainerName(branch);
  }

  async stopAndRemoveContainer(containerName: string): Promise<boolean> {
    const containerID = await this.docker.getContainerByName(containerName);
    if (!containerID) {
      return false;
    }

    try {
      await this.docker.stopContainer(containerID);
    } catch (error: any) {
      if (error.statusCode !== 304) {
        throw error;
      }
    }

    await this.docker.removeContainer(containerID);
    return true;
  }

  async stopAndRemoveBranchContainer(branch: Branch): Promise<boolean> {
    return this.stopAndRemoveContainer(this.getBranchContainerName(branch));
  }

  async destroyDataset(datasetName: string): Promise<boolean> {
    if (!(await this.zfs.datasetExists(datasetName))) {
      return false;
    }

    await this.zfs.unmountDataset(datasetName);
    await this.zfs.destroyDataset(datasetName, true);
    return true;
  }

  async destroyBranchDataset(branch: Branch): Promise<boolean> {
    return this.destroyDataset(branch.zfsDataset);
  }

  async deleteWalArchive(datasetName: string): Promise<void> {
    await this.wal.deleteArchiveDir(datasetName);
  }

  async deleteBranchWalArchive(branch: Branch): Promise<void> {
    await this.deleteWalArchive(branch.zfsDataset);
  }

  async recreateWalArchive(datasetName: string): Promise<string> {
    await this.wal.deleteArchiveDir(datasetName);
    await this.wal.ensureArchiveDir(datasetName);
    return this.wal.getArchivePath(datasetName);
  }
}
