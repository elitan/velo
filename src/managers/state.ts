import * as fs from 'fs/promises';
import type { State } from '../types/state';
import { SystemError } from '../errors';
import { ProjectRepository } from './repositories/project-repository';
import { BranchRepository } from './repositories/branch-repository';
import { SnapshotRepository } from './repositories/snapshot-repository';

export class StateManager {
  private state: State | null = null;
  private lockFile: string;

  // Lazy-initialized repositories
  private _projects: ProjectRepository | null = null;
  private _branches: BranchRepository | null = null;
  private _snapshots: SnapshotRepository | null = null;

  constructor(private filePath: string) {
    this.lockFile = `${filePath}.lock`;
  }

  // Repository accessors (lazy initialization)
  get projects(): ProjectRepository {
    if (!this._projects) {
      this._projects = new ProjectRepository(
        () => this.getState(),
        () => this.save()
      );
    }
    return this._projects;
  }

  get branches(): BranchRepository {
    if (!this._branches) {
      this._branches = new BranchRepository(
        () => this.getState(),
        () => this.save()
      );
    }
    return this._branches;
  }

  get snapshots(): SnapshotRepository {
    if (!this._snapshots) {
      this._snapshots = new SnapshotRepository(
        () => this.getState(),
        () => this.save()
      );
    }
    return this._snapshots;
  }

  // State operations
  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      this.state = JSON.parse(content);

      this.validate();
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Return without error - state will be auto-initialized on first project create
        return;
      }
      throw new SystemError(`Failed to load state: ${error.message}`);
    }
  }

  isInitialized(): boolean {
    return this.state !== null;
  }

  async autoInitialize(pool: string, datasetBase: string): Promise<void> {
    if (this.isInitialized()) {
      return; // Already initialized
    }

    this.state = {
      version: '1.0.0',
      initializedAt: new Date().toISOString(),
      zfsPool: pool,
      zfsDatasetBase: datasetBase,
      projects: [],
      snapshots: [],
    };

    // Create directory if it doesn't exist
    const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
    await fs.mkdir(dir, { recursive: true });

    await this.save();
  }

  async save(): Promise<void> {
    if (!this.state) {
      throw new Error('State not loaded');
    }

    await this.acquireLock();

    try {
      const tempFile = `${this.filePath}.tmp`;
      const backupFile = `${this.filePath}.backup`;

      // Write new state to temp file
      await fs.writeFile(tempFile, JSON.stringify(this.state, null, 2), 'utf-8');

      // Ensure data is written to disk before rename
      const fd = await fs.open(tempFile, 'r');
      await fd.sync();
      await fd.close();

      // Create backup of current state before replacing (if state file exists)
      try {
        await fs.access(this.filePath);
        // State file exists, create backup
        await fs.copyFile(this.filePath, backupFile);
      } catch (error) {
        // State file doesn't exist yet (first write), skip backup
      }

      // Atomically replace old file with new file
      await fs.rename(tempFile, this.filePath);

      // Ensure directory entry is updated
      const dir = await fs.open(this.filePath.substring(0, this.filePath.lastIndexOf('/')), 'r');
      await dir.sync();
      await dir.close();
    } finally {
      await this.releaseLock();
    }
  }

  async restoreFromBackup(): Promise<void> {
    const backupFile = `${this.filePath}.backup`;

    await this.acquireLock();

    try {
      // Check if backup exists
      try {
        await fs.access(backupFile);
      } catch (error) {
        throw new Error('No backup file found');
      }

      // Copy backup to main state file
      await fs.copyFile(backupFile, this.filePath);

      // Reload state from restored file
      await this.load();
    } finally {
      await this.releaseLock();
    }
  }

  async hasBackup(): Promise<boolean> {
    const backupFile = `${this.filePath}.backup`;
    try {
      await fs.access(backupFile);
      return true;
    } catch (error) {
      return false;
    }
  }

  async getBackupInfo(): Promise<{ exists: boolean; modifiedAt?: Date; size?: number }> {
    const backupFile = `${this.filePath}.backup`;
    try {
      const stat = await fs.stat(backupFile);
      return {
        exists: true,
        modifiedAt: stat.mtime,
        size: stat.size,
      };
    } catch (error) {
      return { exists: false };
    }
  }

  async initialize(pool: string, datasetBase: string): Promise<void> {
    this.state = {
      version: '1.0.0',
      initializedAt: new Date().toISOString(),
      zfsPool: pool,
      zfsDatasetBase: `${pool}/${datasetBase}`,
      projects: [],
      snapshots: [],
    };

    await this.save();
  }

  getState(): State {
    if (!this.state) throw new Error('State not loaded');
    return this.state;
  }

  private validate(): void {
    if (!this.state) throw new Error('State is null');

    if (!this.state.version || !this.state.zfsPool || !this.state.projects) {
      throw new Error('Invalid state structure');
    }

    const projNames = new Set<string>();
    const branchNames = new Set<string>();

    for (const proj of this.state.projects) {
      if (projNames.has(proj.name)) {
        throw new Error(`Duplicate project name: ${proj.name}`);
      }
      projNames.add(proj.name);

      // Check that project has a main branch
      const mainBranch = proj.branches.find(b => b.isPrimary);
      if (!mainBranch) {
        throw new Error(`Project '${proj.name}' must have a main branch`);
      }

      for (const branch of proj.branches) {
        // Branch name should be namespaced
        if (!branch.name.includes('/')) {
          throw new Error(`Branch name must be namespaced: ${branch.name}`);
        }

        if (branchNames.has(branch.name)) {
          throw new Error(`Duplicate branch name: ${branch.name}`);
        }
        branchNames.add(branch.name);

        // Validate branch belongs to correct project
        if (branch.projectName !== proj.name) {
          throw new Error(`Branch '${branch.name}' has incorrect projectName`);
        }
      }
    }
  }

  private async acquireLock(): Promise<void> {
    const maxAttempts = 50; // 5 seconds total (50 * 100ms)

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await fs.writeFile(this.lockFile, process.pid.toString(), { flag: 'wx' });
        return;
      } catch (error: any) {
        if (error.code === 'EEXIST') {
          // Check if lock is stale
          try {
            const lockPid = parseInt(await fs.readFile(this.lockFile, 'utf-8'), 10);
            if (!isNaN(lockPid)) {
              try {
                process.kill(lockPid, 0); // Check if process exists
              } catch {
                // Process doesn't exist, remove stale lock
                await fs.unlink(this.lockFile).catch(() => {});
                continue; // Try again immediately
              }
            }
          } catch {
            // Error reading lock file, wait and retry
          }
          await Bun.sleep(100);
        } else {
          throw error;
        }
      }
    }

    throw new Error('Failed to acquire state lock after 5 seconds');
  }

  private async releaseLock(): Promise<void> {
    try {
      await fs.unlink(this.lockFile);
    } catch (error) {
      // Ignore errors
    }
  }
}
