import type { Branch, Project, State } from '../../types/state';
import { UserError } from '../../errors';

export class BranchRepository {
  constructor(
    private getState: () => State,
    private save: () => Promise<void>
  ) {}

  async add(projectId: string, branch: Branch): Promise<void> {
    const state = this.getState();
    const project = state.projects.find(p => p.id === projectId);

    if (!project) {
      throw new UserError(`Project ${projectId} not found`);
    }

    if (project.branches.some(b => b.name === branch.name)) {
      throw new UserError(`Branch '${branch.name}' already exists`);
    }

    project.branches.push(branch);
    await this.save();
  }

  getByNamespace(namespacedName: string): { branch: Branch; project: Project } | null {
    const state = this.getState();

    for (const project of state.projects) {
      const branch = project.branches.find(b => b.name === namespacedName);
      if (branch) {
        return { branch, project };
      }
    }

    return null;
  }

  getMain(projectName: string): Branch | null {
    const state = this.getState();
    const project = state.projects.find(p => p.name === projectName);

    if (!project) return null;

    return project.branches.find(b => b.isPrimary) || null;
  }

  async update(projectId: string, branch: Branch): Promise<void> {
    const state = this.getState();
    const project = state.projects.find(p => p.id === projectId);

    if (!project) {
      throw new UserError(`Project ${projectId} not found`);
    }

    const index = project.branches.findIndex(b => b.id === branch.id);

    if (index === -1) {
      throw new UserError(`Branch ${branch.id} not found`);
    }

    project.branches[index] = branch;
    await this.save();
  }

  async delete(projectId: string, branchId: string): Promise<void> {
    const state = this.getState();
    const project = state.projects.find(p => p.id === projectId);

    if (!project) {
      throw new UserError(`Project ${projectId} not found`);
    }

    const index = project.branches.findIndex(b => b.id === branchId);

    if (index === -1) {
      throw new UserError(`Branch ${branchId} not found`);
    }

    project.branches.splice(index, 1);
    await this.save();
  }

  listAll(): Branch[] {
    const state = this.getState();
    return state.projects.flatMap(p => p.branches);
  }
}
