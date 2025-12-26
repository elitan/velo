import { $ } from 'bun';
import { SystemError } from '../errors';

export interface Dataset {
  name: string;
  type: 'filesystem' | 'snapshot';
  used: number;
  available: number;
  referenced: number;
  mountpoint: string;
  created: Date;
}

export interface Snapshot {
  name: string;
  dataset: string;
  created: Date;
  used: number;
}

export interface PoolStatus {
  name: string;
  health: string;
  size: number;
  allocated: number;
  free: number;
}

export class ZFSManager {
  constructor(
    private pool: string,
    private datasetBase: string
  ) {}

  private getFullPath(name: string): string {
    return `${this.pool}/${this.datasetBase}/${name}`;
  }

  // Pool operations
  async poolExists(): Promise<boolean> {
    try {
      await $`zpool list -H ${this.pool}`.quiet();
      return true;
    } catch {
      return false;
    }
  }

  async createPool(devices: string[]): Promise<void> {
    await $`zpool create ${this.pool} ${devices}`;
  }

  async getPoolStatus(): Promise<PoolStatus> {
    const output = await $`zpool list -H -p ${this.pool}`.text();
    // Format: name size alloc free ckpoint expandsz frag cap dedup health altroot
    const fields = output.trim().split('\t');

    if (fields.length < 10) {
      throw new SystemError(`Invalid zpool output: ${output}`);
    }

    return {
      name: fields[0]!,
      health: fields[9]!,
      size: parseInt(fields[1]!, 10),
      allocated: parseInt(fields[2]!, 10),
      free: parseInt(fields[3]!, 10),
    };
  }

  // Dataset operations
  async createDataset(name: string, options?: Record<string, string>): Promise<void> {
    const fullName = this.getFullPath(name);

    // Note: ZFS may print "filesystem successfully created, but it may only be mounted by root"
    // to stderr. This is expected on Linux and not an error - we'll mount it with sudo later.
    try {
      if (options) {
        const opts = Object.entries(options).flatMap(([key, value]) => ['-o', `${key}=${value}`]);
        await $`zfs create -p ${opts} ${fullName}`.quiet();
      } else {
        await $`zfs create -p ${fullName}`.quiet();
      }
    } catch (error: any) {
      // If the error is just the mount warning, ignore it
      if (error.stderr && error.stderr.includes('may only be mounted by root')) {
        return; // Dataset was created successfully
      }
      throw error;
    }
  }

  async destroyDataset(name: string, recursive = false): Promise<void> {
    const fullName = this.getFullPath(name);
    if (recursive) {
      // Use -R to destroy all dependents (clones) and snapshots
      await $`zfs destroy -R ${fullName}`;
    } else {
      await $`zfs destroy ${fullName}`;
    }
  }

  async datasetExists(name: string): Promise<boolean> {
    try {
      const fullName = this.getFullPath(name);
      await $`zfs list -H ${fullName}`.quiet();
      return true;
    } catch {
      return false;
    }
  }

  async getDataset(name: string): Promise<Dataset> {
    const fullName = this.getFullPath(name);
    const output = await $`zfs list -H -p -o name,used,avail,refer,mountpoint,creation ${fullName}`.text();

    const fields = output.trim().split('\t');
    if (fields.length < 6) {
      throw new SystemError(`Invalid zfs output: ${output}`);
    }

    return {
      name: fields[0]!,
      type: 'filesystem',
      used: parseInt(fields[1]!, 10),
      available: parseInt(fields[2]!, 10),
      referenced: parseInt(fields[3]!, 10),
      mountpoint: fields[4]!,
      created: new Date(parseInt(fields[5]!, 10) * 1000),
    };
  }

  async listDatasets(): Promise<Dataset[]> {
    try {
      const basePath = `${this.pool}/${this.datasetBase}`;
      const output = await $`zfs list -H -p -r -o name,used,avail,refer,type,mountpoint,creation ${basePath}`.text();

      return output
        .trim()
        .split('\n')
        .filter(line => line)
        .map(line => {
          const fields = line.split('\t');
          if (fields.length < 7) {
            throw new SystemError(`Invalid zfs list output: ${line}`);
          }

          return {
            name: fields[0]!,
            type: fields[4] as 'filesystem' | 'snapshot',
            used: parseInt(fields[1]!, 10),
            available: parseInt(fields[2]!, 10),
            referenced: parseInt(fields[3]!, 10),
            mountpoint: fields[5]!,
            created: new Date(parseInt(fields[6]!, 10) * 1000),
          };
        });
    } catch {
      return [];
    }
  }

  async setProperty(dataset: string, key: string, value: string): Promise<void> {
    const fullName = this.getFullPath(dataset);
    await $`zfs set ${key}=${value} ${fullName}`;
  }

  async getProperty(dataset: string, key: string): Promise<string> {
    const fullName = this.getFullPath(dataset);
    const output = await $`zfs get -H -p -o value ${key} ${fullName}`.text();
    return output.trim();
  }

  // Snapshot operations
  async createSnapshot(dataset: string, snapName: string): Promise<void> {
    const fullDataset = this.getFullPath(dataset);
    await $`zfs snapshot ${fullDataset}@${snapName}`;
  }

  async destroySnapshot(snapshot: string): Promise<void> {
    await $`zfs destroy ${snapshot}`;
  }

  async getSnapshotSize(fullSnapshotName: string): Promise<number> {
    const result = await $`zfs list -H -o used -p ${fullSnapshotName}`.text();
    return parseInt(result.trim(), 10);
  }

  async listSnapshots(dataset?: string): Promise<Snapshot[]> {
    try {
      const basePath = dataset
        ? this.getFullPath(dataset)
        : `${this.pool}/${this.datasetBase}`;

      const output = await $`zfs list -H -p -t snapshot -o name,used,creation -r ${basePath}`.text();

      return output
        .trim()
        .split('\n')
        .filter(line => line)
        .map(line => {
          const fields = line.split('\t');
          if (fields.length < 3) {
            throw new SystemError(`Invalid zfs snapshot list output: ${line}`);
          }

          const name = fields[0]!;
          const parts = name.split('@');
          if (parts.length !== 2 || !parts[0]) {
            throw new SystemError(`Invalid snapshot name format: ${name}`);
          }

          return {
            name,
            dataset: parts[0],
            used: parseInt(fields[1]!, 10),
            created: new Date(parseInt(fields[2]!, 10) * 1000),
          };
        });
    } catch {
      return [];
    }
  }

  async snapshotExists(snapshot: string): Promise<boolean> {
    try {
      await $`zfs list -H ${snapshot}`.quiet();
      return true;
    } catch {
      return false;
    }
  }

  // Clone operations
  async cloneSnapshot(snapshot: string, target: string): Promise<void> {
    const fullTarget = this.getFullPath(target);

    // Note: ZFS may print "filesystem successfully created, but it may only be mounted by root"
    // to stderr. This is expected on Linux and not an error - we'll mount it with sudo later.
    try {
      await $`zfs clone ${snapshot} ${fullTarget}`.quiet();
    } catch (error: any) {
      // If the error is just the mount warning, ignore it
      if (error.stderr && error.stderr.includes('may only be mounted by root')) {
        return; // Dataset was created successfully
      }
      throw error;
    }
  }

  async promoteClone(clone: string): Promise<void> {
    const fullClone = this.getFullPath(clone);
    await $`zfs promote ${fullClone}`;
  }

  // Utility functions
  async getUsedSpace(dataset: string): Promise<number> {
    const fullName = this.getFullPath(dataset);
    const output = await $`zfs list -H -p -o used ${fullName}`.text();
    return parseInt(output.trim(), 10);
  }

  async getSharedSpace(clone: string): Promise<number> {
    const fullClone = this.getFullPath(clone);
    const output = await $`zfs list -H -p -o referenced ${fullClone}`.text();
    return parseInt(output.trim(), 10);
  }

  async getMountpoint(dataset: string): Promise<string> {
    const fullName = this.getFullPath(dataset);
    const output = await $`zfs get -H -p -o value mountpoint ${fullName}`.text();
    return output.trim();
  }

  /**
   * Mount a dataset
   * Requires sudo on Linux due to kernel CAP_SYS_ADMIN requirement
   */
  async mountDataset(dataset: string): Promise<void> {
    const fullName = this.getFullPath(dataset);
    try {
      await $`sudo zfs mount ${fullName}`.quiet();
    } catch (error: any) {
      // Ignore "already mounted" errors - this makes the operation idempotent
      if (error.stderr && error.stderr.includes('already mounted')) {
        return;
      }
      throw error;
    }
  }

  /**
   * Unmount a dataset
   * Requires sudo on Linux due to kernel CAP_SYS_ADMIN requirement
   */
  async unmountDataset(dataset: string): Promise<void> {
    const fullName = this.getFullPath(dataset);
    try {
      await $`sudo zfs unmount ${fullName}`.quiet();
    } catch (error: any) {
      // Ignore "not currently mounted" errors - this makes the operation idempotent
      if (error.stderr && (error.stderr.includes('not currently mounted') || error.stderr.includes('not mounted'))) {
        return;
      }
      throw error;
    }
  }
}
