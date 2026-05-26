import { afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../db/client';
import { migrateDatabase } from '../db/migrate';

export type TestDatabaseContext = {
  readonly testDir: string;
};

export function useTestDatabase(prefix: string): TestDatabaseContext {
  let testDir = '';

  beforeEach(function setupDatabase() {
    testDir = mkdtempSync(join(tmpdir(), prefix));
    process.env.VELO_DB = join(testDir, 'velo.sqlite');
    migrateDatabase();
  });

  afterEach(async function cleanupDatabase() {
    await closeDb();
    delete process.env.VELO_DB;
    rmSync(testDir, { recursive: true, force: true });
  });

  return {
    get testDir() {
      return testDir;
    },
  };
}

export async function createProject(): Promise<number> {
  await getDb()
    .insertInto('projects')
    .values({
      name: 'prod',
      postgresVersion: '17',
      databaseName: 'postgres',
      appUser: 'postgres',
    })
    .execute();

  const project = await getDb().selectFrom('projects').select('id').where('name', '=', 'prod').executeTakeFirstOrThrow();

  return project.id;
}

export async function createBranchRecord(input: {
  projectId: number;
  slug: string;
  displayName: string;
  dataset: string;
  parentBranchId?: number | null;
  port?: number | null;
  proxyPort?: number | null;
  backendPort?: number | null;
  connectionUrl?: string | null;
  lastActiveAt?: string | null;
  status?: 'creating' | 'running' | 'stopped' | 'error';
}): Promise<number> {
  await getDb()
    .insertInto('branches')
    .values({
      projectId: input.projectId,
      slug: input.slug,
      displayName: input.displayName,
      dataset: input.dataset,
      status: input.status ?? 'running',
      parentBranchId: input.parentBranchId ?? null,
      port: input.port ?? null,
      proxyPort: input.proxyPort ?? null,
      backendPort: input.backendPort ?? null,
      connectionUrl: input.connectionUrl ?? null,
      lastActiveAt: input.lastActiveAt ?? null,
    })
    .execute();

  const branch = await getDb().selectFrom('branches').select('id').where('slug', '=', input.slug).executeTakeFirstOrThrow();

  return branch.id;
}
