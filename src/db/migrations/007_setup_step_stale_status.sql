alter table setup_steps rename to setup_steps_old;

create table setup_steps (
  id integer primary key autoincrement,
  key text not null unique,
  label text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'error', 'stale')),
  message text,
  updated_at text not null default (datetime('now'))
);

insert into setup_steps (id, key, label, status, message, updated_at)
select id, key, label, status, message, updated_at
from setup_steps_old;

drop table setup_steps_old;
