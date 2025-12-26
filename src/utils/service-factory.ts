import { StateManager } from '../managers/state';
import { ZFSManager } from '../managers/zfs';
import { DockerManager } from '../managers/docker';
import { WALManager } from '../managers/wal';
import { CertManager } from '../managers/cert';
import { PATHS } from './paths';
import type { State, Project, Branch } from '../types/state';
import { UserError } from '../errors';
import { CLI_NAME } from '../config/constants';

export interface Services {
  state: StateManager;
  zfs: ZFSManager;
  docker: DockerManager;
  wal: WALManager;
  cert: CertManager;
  stateData: State;
}

export interface ServiceOverrides {
  state?: StateManager;
  zfs?: ZFSManager;
  docker?: DockerManager;
  wal?: WALManager;
  cert?: CertManager;
}

export interface BranchWithProject {
  branch: Branch;
  project: Project;
}

/**
 * Initialize all service managers
 * Loads state and creates ZFS, Docker, WAL, and Cert managers
 * Accepts optional overrides for dependency injection (useful for testing)
 */
export async function initializeServices(overrides: ServiceOverrides = {}): Promise<Services> {
  const state = overrides.state || new StateManager(PATHS.STATE);

  if (!overrides.state) {
    await state.load();
  }

  const stateData = state.getState();

  return {
    state,
    zfs: overrides.zfs || new ZFSManager(stateData.zfsPool, stateData.zfsDatasetBase),
    docker: overrides.docker || new DockerManager(),
    wal: overrides.wal || new WALManager(),
    cert: overrides.cert || new CertManager(),
    stateData,
  };
}

/**
 * Get branch with its parent project by namespace
 * Throws UserError if not found
 */
export async function getBranchWithProject(
  state: StateManager,
  branchName: string
): Promise<BranchWithProject> {
  const result = state.branches.getByNamespace(branchName);
  if (!result) {
    throw new UserError(
      `Branch '${branchName}' not found`,
      `Run '${CLI_NAME} branch list' to see available branches`
    );
  }
  return result;
}

/**
 * Get project by name
 * Throws UserError if not found
 */
export async function getProject(
  state: StateManager,
  projectName: string
): Promise<Project> {
  const project = state.projects.getByName(projectName);
  if (!project) {
    throw new UserError(
      `Project '${projectName}' not found`,
      `Run '${CLI_NAME} project list' to see available projects`
    );
  }
  return project;
}
