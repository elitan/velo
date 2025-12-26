import type { Project, State } from '../../types/state';
import { UserError } from '../../errors';

export class ProjectRepository {
  constructor(
    private getState: () => State,
    private save: () => Promise<void>
  ) {}

  async add(project: Project): Promise<void> {
    const state = this.getState();

    if (state.projects.some(p => p.name === project.name)) {
      throw new UserError(`Project '${project.name}' already exists`);
    }

    state.projects.push(project);
    await this.save();
  }

  getByName(name: string): Project | null {
    const state = this.getState();
    return state.projects.find(p => p.name === name) || null;
  }

  async update(project: Project): Promise<void> {
    const state = this.getState();
    const index = state.projects.findIndex(p => p.id === project.id);

    if (index === -1) {
      throw new UserError(`Project ${project.id} not found`);
    }

    state.projects[index] = project;
    await this.save();
  }

  async delete(name: string): Promise<void> {
    const state = this.getState();
    const index = state.projects.findIndex(p => p.name === name);

    if (index === -1) {
      throw new UserError(`Project '${name}' not found`);
    }

    state.projects.splice(index, 1);
    await this.save();
  }

  list(): Project[] {
    const state = this.getState();
    return [...state.projects];
  }
}
