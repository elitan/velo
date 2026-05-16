alter table setup_steps add column failed_job_id integer;

alter table job_logs rename to job_logs_old;
alter table jobs rename to jobs_old;

create table jobs (
  id integer primary key autoincrement,
  type text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error', 'cancelled')),
  input_json text,
  error text,
  attempts integer not null default 0,
  max_attempts integer not null default 1,
  run_after text,
  locked_at text,
  locked_by text,
  heartbeat_at text,
  created_at text not null default (datetime('now')),
  started_at text,
  finished_at text,
  updated_at text not null default (datetime('now'))
);

create table job_logs (
  id integer primary key autoincrement,
  job_id integer not null references jobs(id) on delete cascade,
  level text not null default 'info' check (level in ('info', 'error')),
  message text not null,
  created_at text not null default (datetime('now'))
);

insert into jobs (
  id,
  type,
  status,
  input_json,
  error,
  attempts,
  max_attempts,
  run_after,
  locked_at,
  locked_by,
  heartbeat_at,
  created_at,
  started_at,
  finished_at,
  updated_at
)
select
  id,
  type,
  status,
  input_json,
  error,
  attempts,
  max_attempts,
  run_after,
  locked_at,
  locked_by,
  heartbeat_at,
  created_at,
  started_at,
  finished_at,
  updated_at
from jobs_old;

insert into job_logs (
  id,
  job_id,
  level,
  message,
  created_at
)
select
  id,
  job_id,
  level,
  message,
  created_at
from job_logs_old;

drop table job_logs_old;
drop table jobs_old;

create index if not exists job_logs_job_id_created_at_idx on job_logs(job_id, created_at);
create index if not exists jobs_status_created_at_idx on jobs(status, created_at);
create index if not exists jobs_queue_idx on jobs(status, run_after, id);
create index if not exists jobs_running_heartbeat_idx on jobs(status, heartbeat_at);
