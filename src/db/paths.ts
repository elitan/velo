import { homedir } from 'node:os';

export function getDatabasePath(): string {
  return process.env.VELO_DB || `${homedir()}/.velo/velo.sqlite`;
}
