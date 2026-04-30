import { Kysely, SqliteDialect } from 'kysely';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DB } from './schema';
import { getDatabasePath } from './paths';
import { BunSqliteDatabase } from './bun-sqlite';

let db: Kysely<DB> | null = null;

export function getDb(): Kysely<DB> {
  if (db) {
    return db;
  }

  const databasePath = getDatabasePath();
  mkdirSync(dirname(databasePath), { recursive: true });

  db = new Kysely<DB>({
    dialect: new SqliteDialect({
      database: new BunSqliteDatabase(databasePath),
    }),
  });

  return db;
}

export async function closeDb(): Promise<void> {
  if (!db) {
    return;
  }

  await db.destroy();
  db = null;
}
