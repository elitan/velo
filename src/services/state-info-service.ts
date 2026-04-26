import * as fs from 'fs/promises';
import { StateManager } from '../managers/state';
import { CURRENT_STATE_SCHEMA_VERSION } from '../managers/state-migration';

export type StateSchemaStatus = 'missing' | 'current' | 'migrated' | 'unsupported' | 'invalid';

export interface StateInfo {
  stateFile: string;
  backupFile: string;
  exists: boolean;
  initialized: boolean;
  currentSchemaVersion: number;
  schemaVersion?: number;
  schemaStatus: StateSchemaStatus;
  migrationApplied: boolean;
  projectCount: number;
  branchCount: number;
  snapshotCount: number;
  zfsPool?: string;
  zfsDatasetBase?: string;
  initializedAt?: string;
  backup: {
    exists: boolean;
    modifiedAt?: Date;
    size?: number;
  };
  error?: string;
}

export async function getStateInfo(stateFile: string): Promise<StateInfo> {
  const backupFile = `${stateFile}.backup`;
  const backup = await getBackupInfo(backupFile);
  const baseInfo = {
    stateFile,
    backupFile,
    currentSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    backup,
  };

  try {
    await fs.access(stateFile);
  } catch {
    return {
      ...baseInfo,
      exists: false,
      initialized: false,
      schemaStatus: 'missing',
      migrationApplied: false,
      projectCount: 0,
      branchCount: 0,
      snapshotCount: 0,
    };
  }

  let rawSchemaVersion = 1;
  let rawContent: string;

  try {
    rawContent = await fs.readFile(stateFile, 'utf-8');
    const rawState = JSON.parse(rawContent);
    rawSchemaVersion = rawState.schemaVersion ?? 1;
  } catch (error: any) {
    return {
      ...baseInfo,
      exists: true,
      initialized: false,
      schemaStatus: 'invalid',
      migrationApplied: false,
      projectCount: 0,
      branchCount: 0,
      snapshotCount: 0,
      error: error.message,
    };
  }

  if (rawSchemaVersion > CURRENT_STATE_SCHEMA_VERSION) {
    return {
      ...baseInfo,
      exists: true,
      initialized: false,
      schemaVersion: rawSchemaVersion,
      schemaStatus: 'unsupported',
      migrationApplied: false,
      projectCount: 0,
      branchCount: 0,
      snapshotCount: 0,
      error: `Unsupported state schema version: ${rawSchemaVersion}`,
    };
  }

  try {
    const state = new StateManager(stateFile);
    await state.load();

    if (!state.isInitialized()) {
      return {
        ...baseInfo,
        backup: await getBackupInfo(backupFile),
        exists: true,
        initialized: false,
        schemaVersion: rawSchemaVersion,
        schemaStatus: 'missing',
        migrationApplied: false,
        projectCount: 0,
        branchCount: 0,
        snapshotCount: 0,
      };
    }

    const stateData = state.getState();
    const branchCount = stateData.projects.reduce(function countBranches(total, project) {
      return total + project.branches.length;
    }, 0);
    const migrationApplied = rawSchemaVersion < CURRENT_STATE_SCHEMA_VERSION;

    return {
      ...baseInfo,
      backup: await getBackupInfo(backupFile),
      exists: true,
      initialized: true,
      schemaVersion: stateData.schemaVersion,
      schemaStatus: migrationApplied ? 'migrated' : 'current',
      migrationApplied,
      projectCount: stateData.projects.length,
      branchCount,
      snapshotCount: stateData.snapshots.length,
      zfsPool: stateData.zfsPool,
      zfsDatasetBase: stateData.zfsDatasetBase,
      initializedAt: stateData.initializedAt,
    };
  } catch (error: any) {
    return {
      ...baseInfo,
      backup: await getBackupInfo(backupFile),
      exists: true,
      initialized: false,
      schemaVersion: rawSchemaVersion,
      schemaStatus: 'invalid',
      migrationApplied: false,
      projectCount: 0,
      branchCount: 0,
      snapshotCount: 0,
      error: error.message,
    };
  }
}

async function getBackupInfo(backupFile: string): Promise<StateInfo['backup']> {
  try {
    const stat = await fs.stat(backupFile);

    return {
      exists: true,
      modifiedAt: stat.mtime,
      size: stat.size,
    };
  } catch {
    return {
      exists: false,
    };
  }
}
