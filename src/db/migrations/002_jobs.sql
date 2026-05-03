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
