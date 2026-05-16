alter table branches add column proxy_port integer;
alter table branches add column backend_port integer;
alter table branches add column last_active_at text;
alter table branches add column stopped_at text;

update branches
set backend_port = port,
    last_active_at = coalesce(updated_at, created_at)
where backend_port is null;

create unique index if not exists branches_proxy_port_idx on branches(proxy_port) where proxy_port is not null;
