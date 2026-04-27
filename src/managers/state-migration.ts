import type { Branch, State } from '../types/state';
import { getContainerName, getLegacyContainerName } from '../utils/naming';
import { parseNamespace } from '../utils/namespace';

export const CURRENT_STATE_SCHEMA_VERSION = 3;

type MigratableState = Partial<State> & {
  schemaVersion?: number;
  projects?: Array<any>;
};

export interface MigrationResult {
  state: State;
  migrated: boolean;
}

export function migrateState(rawState: MigratableState): MigrationResult {
  const schemaVersion = rawState.schemaVersion ?? 1;

  if (schemaVersion > CURRENT_STATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported state schema version: ${schemaVersion}`);
  }

  let migrated = false;

  if (!rawState.schemaVersion) {
    rawState.schemaVersion = 1;
    migrated = true;
  }

  if (rawState.zfsPool && rawState.zfsDatasetBase) {
    const poolPrefix = `${rawState.zfsPool}/`;

    if (rawState.zfsDatasetBase.startsWith(poolPrefix)) {
      rawState.zfsDatasetBase = rawState.zfsDatasetBase.slice(poolPrefix.length);
      migrated = true;
    }
  }

  if (rawState.projects) {
    for (const project of rawState.projects) {
      for (const branch of project.branches || []) {
        if (!branch.containerName) {
          branch.containerName = getMigratedContainerName(branch);
          migrated = true;
        }
      }
    }
  }

  if (rawState.schemaVersion !== CURRENT_STATE_SCHEMA_VERSION) {
    rawState.schemaVersion = CURRENT_STATE_SCHEMA_VERSION;
    migrated = true;
  }

  return {
    state: rawState as State,
    migrated,
  };
}

function getMigratedContainerName(branch: Branch): string {
  const namespace = parseNamespace(branch.name);

  if (branch.zfsDataset.includes('.')) {
    return getContainerName(namespace.project, namespace.branch);
  }

  return getLegacyContainerName(namespace.project, namespace.branch);
}
