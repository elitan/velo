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
