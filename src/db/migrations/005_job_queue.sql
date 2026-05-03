alter table jobs add column attempts integer not null default 0;
alter table jobs add column max_attempts integer not null default 1;
alter table jobs add column run_after text;
alter table jobs add column locked_at text;
alter table jobs add column locked_by text;
alter table jobs add column heartbeat_at text;

update jobs set run_after = datetime('now') where run_after is null;

create index if not exists jobs_queue_idx on jobs(status, run_after, id);
create index if not exists jobs_running_heartbeat_idx on jobs(status, heartbeat_at);
