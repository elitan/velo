import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import type { DB } from './schema';
import { getDatabasePath } from './paths';
import { BunSqliteDatabase } from './bun-sqlite';
import { ensureStateDirectory, protectDatabaseFiles } from './state-permissions';

let db: Kysely<DB> | null = null;

export function getDb(): Kysely<DB> {
  if (db) {
    return db;
  }

  const databasePath = getDatabasePath();
  ensureStateDirectory(databasePath);

  db = new Kysely<DB>({
    dialect: new SqliteDialect({
      database: new BunSqliteDatabase(databasePath),
    }),
    plugins: [new CamelCasePlugin()],
  });
  protectDatabaseFiles(databasePath);

  return db;
}

export async function closeDb(): Promise<void> {
  if (!db) {
    return;
  }

  await db.destroy();
  db = null;
}
