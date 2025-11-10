import * as fs from 'fs/promises';
import type { State, Project, Branch, Snapshot } from '../types/state';
import { UserError, SystemError } from '../errors';

export class StateManager {
  private state: State | null = null;
  private lockFile: string;

  constructor(private filePath: string) {
    this.lockFile = `${filePath}.lock`;
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

  /**
   * Check if state is initialized
   */
  isInitialized(): boolean {
    return this.state !== null;
  }

  /**
   * Auto-initialize state if not already initialized
   * Called automatically on first project create
   */
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

  // Project operations
  async addProject(proj: Project): Promise<void> {
    if (!this.state) throw new Error('State not loaded');

    if (this.state.projects.some(p => p.name === proj.name)) {
      throw new UserError(`Project '${proj.name}' already exists`);
    }

    this.state.projects.push(proj);
    await this.save();
  }

  async getProjectByName(name: string): Promise<Project | null> {
    if (!this.state) throw new Error('State not loaded');
    return this.state.projects.find(proj => proj.name === name) || null;
  }

  async updateProject(proj: Project): Promise<void> {
    if (!this.state) throw new Error('State not loaded');

    const index = this.state.projects.findIndex(p => p.id === proj.id);
    if (index === -1) {
      throw new UserError(`Project ${proj.id} not found`);
    }

    this.state.projects[index] = proj;
    await this.save();
  }

  async deleteProject(name: string): Promise<void> {
    if (!this.state) throw new Error('State not loaded');

    const index = this.state.projects.findIndex(proj => proj.name === name);

    if (index === -1) {
      throw new UserError(`Project '${name}' not found`);
    }

    this.state.projects.splice(index, 1);
    await this.save();
  }

  async listProjects(): Promise<Project[]> {
    if (!this.state) throw new Error('State not loaded');
    return [...this.state.projects];
  }

  // Branch operations
  async addBranch(projectID: string, branch: Branch): Promise<void> {
    if (!this.state) throw new Error('State not loaded');

    const proj = this.state.projects.find(p => p.id === projectID);
    if (!proj) {
      throw new UserError(`Project ${projectID} not found`);
    }

    if (proj.branches.some(b => b.name === branch.name)) {
      throw new UserError(`Branch '${branch.name}' already exists`);
    }

    proj.branches.push(branch);
    await this.save();
  }

  async getBranchByNamespace(namespacedName: string): Promise<{ branch: Branch; project: Project } | null> {
    if (!this.state) throw new Error('State not loaded');

    for (const proj of this.state.projects) {
      const branch = proj.branches.find(b => b.name === namespacedName);
      if (branch) {
        return { branch, project: proj };
      }
    }

    return null;
  }

  async getMainBranch(projectName: string): Promise<Branch | null> {
    if (!this.state) throw new Error('State not loaded');

    const proj = this.state.projects.find(p => p.name === projectName);
    if (!proj) return null;

    return proj.branches.find(b => b.isPrimary) || null;
  }

  async updateBranch(projectID: string, branch: Branch): Promise<void> {
    if (!this.state) throw new Error('State not loaded');

    const proj = this.state.projects.find(p => p.id === projectID);
    if (!proj) {
      throw new UserError(`Project ${projectID} not found`);
    }

    const index = proj.branches.findIndex(b => b.id === branch.id);
    if (index === -1) {
      throw new UserError(`Branch ${branch.id} not found`);
    }

    proj.branches[index] = branch;
    await this.save();
  }

  async deleteBranch(projectID: string, branchID: string): Promise<void> {
    if (!this.state) throw new Error('State not loaded');

    const proj = this.state.projects.find(p => p.id === projectID);
    if (!proj) {
      throw new UserError(`Project ${projectID} not found`);
    }

    const index = proj.branches.findIndex(b => b.id === branchID);
    if (index === -1) {
      throw new UserError(`Branch ${branchID} not found`);
    }

    proj.branches.splice(index, 1);
    await this.save();
  }

  async listAllBranches(): Promise<Branch[]> {
    if (!this.state) throw new Error('State not loaded');
    return this.state.projects.flatMap(proj => proj.branches);
  }

  // Snapshot operations
  async addSnapshot(snapshot: Snapshot): Promise<void> {
    if (!this.state) throw new Error('State not loaded');
    this.state.snapshots.push(snapshot);
    await this.save();
  }

  async getSnapshotsForBranch(branchName: string): Promise<Snapshot[]> {
    if (!this.state) throw new Error('State not loaded');
    return this.state.snapshots.filter(s => s.branchName === branchName);
  }

  async getSnapshotsForProject(projectName: string): Promise<Snapshot[]> {
    if (!this.state) throw new Error('State not loaded');
    return this.state.snapshots.filter(s => s.projectName === projectName);
  }

  async getSnapshotById(id: string): Promise<Snapshot | undefined> {
    if (!this.state) throw new Error('State not loaded');
    return this.state.snapshots.find(s => s.id === id);
  }

  async deleteSnapshot(id: string): Promise<void> {
    if (!this.state) throw new Error('State not loaded');
    const index = this.state.snapshots.findIndex(s => s.id === id);
    if (index === -1) {
      throw new UserError(`Snapshot not found: ${id}`);
    }
    this.state.snapshots.splice(index, 1);
    await this.save();
  }

  async deleteSnapshotsForBranch(branchName: string): Promise<void> {
    if (!this.state) throw new Error('State not loaded');
    this.state.snapshots = this.state.snapshots.filter(s => s.branchName !== branchName);
    await this.save();
  }

  async deleteOldSnapshots(branchName: string | undefined, retentionDays: number, dryRun: boolean = false): Promise<Snapshot[]> {
    if (!this.state) throw new Error('State not loaded');

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const toDelete = this.state.snapshots.filter(s => {
      const isOld = new Date(s.createdAt) < cutoff;
      if (branchName) {
        return s.branchName === branchName && isOld;
      }
      return isOld;
    });

    if (!dryRun) {
      this.state.snapshots = this.state.snapshots.filter(s => {
        const isOld = new Date(s.createdAt) < cutoff;
        if (branchName) {
          return s.branchName !== branchName || !isOld;
        }
        return !isOld;
      });

      await this.save();
    }

    return toDelete;
  }

  async getAllSnapshots(): Promise<Snapshot[]> {
    if (!this.state) throw new Error('State not loaded');
    return this.state.snapshots;
  }

  // Utility
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
