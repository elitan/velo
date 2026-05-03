create table branches_new (
  id integer primary key autoincrement,
  project_id integer not null references projects(id) on delete cascade,
  slug text not null,
  display_name text not null,
  dataset text not null,
  port integer,
  status text not null default 'creating' check (status in ('creating', 'running', 'stopped', 'error')),
  parent_branch_id integer references branches(id) on delete set null,
  source_replay_at text,
  connection_url text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now')),
  unique(project_id, slug)
);

insert into branches_new (
  id,
  project_id,
  slug,
  display_name,
  dataset,
  port,
  status,
  parent_branch_id,
  source_replay_at,
  connection_url,
  created_at,
  updated_at
)
select
  id,
  project_id,
  name,
  name,
  dataset,
  port,
  status,
  parent_branch_id,
  source_replay_at,
  connection_url,
  created_at,
  updated_at
from branches;

drop table branches;
alter table branches_new rename to branches;
create unique index if not exists branches_project_id_slug_idx on branches(project_id, slug);
