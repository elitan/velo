import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { getDatabasePath } from './paths';

const migrations = [
  {
    id: '001_initial',
    sql: `
      create table if not exists schema_migrations (
        id text primary key,
        applied_at text not null default (datetime('now'))
      );

      create table if not exists settings (
        key text primary key,
        value text not null,
        created_at text not null default (datetime('now')),
        updated_at text not null default (datetime('now'))
      );

      create table if not exists servers (
        id integer primary key autoincrement,
        role text not null check (role in ('prod', 'dev')),
        host text not null,
        ssh_user text not null,
        ssh_key_path text not null,
        status text not null default 'unknown' check (status in ('unknown', 'ok', 'error')),
        status_message text,
        last_checked_at text,
        created_at text not null default (datetime('now')),
        updated_at text not null default (datetime('now')),
        unique(role)
      );

      create table if not exists setup_steps (
        id integer primary key autoincrement,
        key text not null unique,
        label text not null,
        status text not null default 'pending' check (status in ('pending', 'running', 'done', 'error')),
        message text,
        updated_at text not null default (datetime('now'))
      );

      create table if not exists projects (
        id integer primary key autoincrement,
        name text not null unique,
        postgres_version text not null default '17',
        database_name text not null default 'postgres',
        app_user text not null default 'postgres',
        created_at text not null default (datetime('now')),
        updated_at text not null default (datetime('now'))
      );

      create table if not exists branches (
        id integer primary key autoincrement,
        project_id integer not null references projects(id) on delete cascade,
        name text not null,
        dataset text not null,
        port integer,
        status text not null default 'creating' check (status in ('creating', 'running', 'stopped', 'error')),
        source_replay_at text,
        connection_url text,
        created_at text not null default (datetime('now')),
        updated_at text not null default (datetime('now')),
        unique(project_id, name)
      );

      insert or ignore into setup_steps (key, label) values
        ('dev-check', 'Check dev server'),
        ('prod-check', 'Check prod server'),
        ('prod-setup', 'Configure prod Postgres'),
        ('backups', 'Configure backups and PITR'),
        ('replica', 'Create dev replica'),
        ('first-branch', 'Create first branch');
    `,
  },
  {
    id: '002_jobs',
    sql: `
      create table if not exists jobs (
        id integer primary key autoincrement,
        type text not null,
        status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error')),
        input_json text,
        error text,
        created_at text not null default (datetime('now')),
        started_at text,
        finished_at text,
        updated_at text not null default (datetime('now'))
      );

      create table if not exists job_logs (
        id integer primary key autoincrement,
        job_id integer not null references jobs(id) on delete cascade,
        level text not null default 'info' check (level in ('info', 'error')),
        message text not null,
        created_at text not null default (datetime('now'))
      );

      create index if not exists job_logs_job_id_created_at_idx on job_logs(job_id, created_at);
      create index if not exists jobs_status_created_at_idx on jobs(status, created_at);
    `,
  },
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

  for (const migration of migrations) {
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

if (import.meta.main) {
  migrateDatabase();
  console.log(`Migrated ${getDatabasePath()}`);
}
