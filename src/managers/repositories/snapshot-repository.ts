import type { Snapshot, State } from '../../types/state';
import { UserError } from '../../errors';

export class SnapshotRepository {
  constructor(
    private getState: () => State,
    private save: () => Promise<void>
  ) {}

  async add(snapshot: Snapshot): Promise<void> {
    const state = this.getState();
    state.snapshots.push(snapshot);
    await this.save();
  }

  getForBranch(branchName: string): Snapshot[] {
    const state = this.getState();
    return state.snapshots.filter(s => s.branchName === branchName);
  }

  getForProject(projectName: string): Snapshot[] {
    const state = this.getState();
    return state.snapshots.filter(s => s.projectName === projectName);
  }

  getById(id: string): Snapshot | undefined {
    const state = this.getState();
    return state.snapshots.find(s => s.id === id);
  }

  async delete(id: string): Promise<void> {
    const state = this.getState();
    const index = state.snapshots.findIndex(s => s.id === id);

    if (index === -1) {
      throw new UserError(`Snapshot not found: ${id}`);
    }

    state.snapshots.splice(index, 1);
    await this.save();
  }

  async deleteForBranch(branchName: string): Promise<void> {
    const state = this.getState();
    state.snapshots = state.snapshots.filter(s => s.branchName !== branchName);
    await this.save();
  }

  async deleteOld(
    branchName: string | undefined,
    retentionDays: number,
    dryRun: boolean = false
  ): Promise<Snapshot[]> {
    const state = this.getState();

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const toDelete = state.snapshots.filter(s => {
      const isOld = new Date(s.createdAt) < cutoff;
      if (branchName) {
        return s.branchName === branchName && isOld;
      }
      return isOld;
    });

    if (!dryRun) {
      state.snapshots = state.snapshots.filter(s => {
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

  getAll(): Snapshot[] {
    const state = this.getState();
    return state.snapshots;
  }
}
