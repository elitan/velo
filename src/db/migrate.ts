import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import { getDatabasePath } from './paths';

interface Migration {
  id: string;
  sql: string;
}

const migrationsDirs = [
  join(dirname(fileURLToPath(import.meta.url)), 'migrations'),
  join(process.cwd(), 'src/db/migrations'),
];

export function migrateDatabase(): void {
  const databasePath = getDatabasePath();
  mkdirSync(dirname(databasePath), { recursive: true });

  const db = new Database(databasePath);
  db.exec('pragma journal_mode = WAL');
  db.exec('pragma foreign_keys = ON');
  db.exec(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at text not null default (datetime('now'))
    );
  `);

  for (const migration of readMigrations()) {
    const applied = db
      .prepare('select id from schema_migrations where id = ?')
      .get(migration.id);

    if (applied) {
      continue;
    }

    const applyMigration = db.transaction(function applyMigration() {
      db.exec(migration.sql);
      db.prepare('insert into schema_migrations (id) values (?)').run(migration.id);
    });

    applyMigration();
  }

  db.close();
}

function readMigrations(): Migration[] {
  const migrationsDir = getMigrationsDirectory();

  return readdirSync(migrationsDir)
    .filter(function isSqlFile(fileName) {
      return fileName.endsWith('.sql');
    })
    .sort()
    .map(function readMigration(fileName) {
      return {
        id: fileName.replace(/\.sql$/, ''),
        sql: readFileSync(join(migrationsDir, fileName), 'utf8'),
      };
    });
}

export function getMigrationsDirectory(): string {
  const migrationsDir = migrationsDirs.find(function directoryExists(directory) {
    return existsSync(directory);
  });

  if (!migrationsDir) {
    throw new Error(`Missing migrations directory: ${migrationsDirs.join(', ')}`);
  }

  return migrationsDir;
}

if (import.meta.main) {
  migrateDatabase();
  console.log(`Migrated ${getDatabasePath()}`);
}
