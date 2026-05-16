import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function ensureStateDirectory(databasePath: string): void {
  const stateDirectory = dirname(databasePath);
  mkdirSync(stateDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(stateDirectory, PRIVATE_DIRECTORY_MODE);
}

export function protectDatabaseFiles(databasePath: string): void {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    chmodIfExists(path, PRIVATE_FILE_MODE);
  }
}

function chmodIfExists(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }
}
