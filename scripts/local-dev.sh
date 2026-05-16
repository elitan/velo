#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.local.yml"
DEFAULT_INSTANCE="$(git -C "$ROOT_DIR" branch --show-current 2>/dev/null || basename "$ROOT_DIR")"
DEFAULT_INSTANCE="$(printf '%s' "$DEFAULT_INSTANCE" | tr -c '[:alnum:]' '-' | tr '[:upper:]' '[:lower:]' | sed 's/^-*//; s/-*$//; s/--*/-/g')"
INSTANCE_ID="${VELO_LOCAL_INSTANCE:-${DEFAULT_INSTANCE:-default}}"
COMPOSE_PROJECT_NAME="velo-$INSTANCE_ID"
LOCAL_STATE_DIR="$ROOT_DIR/.velo/local/$INSTANCE_ID"
LOCAL_ENV_FILE="$LOCAL_STATE_DIR/env"
LOCAL_DB="${VELO_DB:-$LOCAL_STATE_DIR/velo.sqlite}"

umask 077
mkdir -p -m 700 "$LOCAL_STATE_DIR"
chmod 700 "$ROOT_DIR/.velo" "$ROOT_DIR/.velo/local" "$LOCAL_STATE_DIR" 2>/dev/null || true

export COMPOSE_PROJECT_NAME
export VELO_LOCAL_DOCKER=1
export VELO_LOCAL_INSTANCE="$INSTANCE_ID"
export VELO_DB="$LOCAL_DB"
export VELO_LOCAL_COMPOSE_PROJECT="$COMPOSE_PROJECT_NAME"
export VELO_LOCAL_COMPOSE_FILE="$COMPOSE_FILE"

load_env_file() {
  if [ -f "$LOCAL_ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$LOCAL_ENV_FILE"
    set +a
  fi
}

save_env_file() {
  cat > "$LOCAL_ENV_FILE" <<EOF
VELO_LOCAL_INSTANCE=$INSTANCE_ID
VELO_LOCAL_COMPOSE_PROJECT=$COMPOSE_PROJECT_NAME
VELO_LOCAL_PROD_PORT=$VELO_LOCAL_PROD_PORT
VELO_LOCAL_DEV_PORT=$VELO_LOCAL_DEV_PORT
VELO_LOCAL_MINIO_PORT=$VELO_LOCAL_MINIO_PORT
VELO_LOCAL_MINIO_CONSOLE_PORT=$VELO_LOCAL_MINIO_CONSOLE_PORT
VELO_LOCAL_WEB_PORT=$VELO_LOCAL_WEB_PORT
VELO_LOCAL_APP_PASSWORD=$VELO_LOCAL_APP_PASSWORD
EOF
  chmod 600 "$LOCAL_ENV_FILE"
}

get_free_port() {
  python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
}

port_is_free() {
  python3 - "$1" <<'PY'
import socket
import sys

port = int(sys.argv[1])
with socket.socket() as sock:
    try:
        sock.bind(("127.0.0.1", port))
    except OSError:
        sys.exit(1)
PY
}

ensure_ports() {
  load_env_file
  export VELO_LOCAL_PROD_PORT="${VELO_LOCAL_PROD_PORT:-$(get_free_port)}"
  export VELO_LOCAL_DEV_PORT="${VELO_LOCAL_DEV_PORT:-$(get_free_port)}"
  export VELO_LOCAL_MINIO_PORT="${VELO_LOCAL_MINIO_PORT:-$(get_free_port)}"
  export VELO_LOCAL_MINIO_CONSOLE_PORT="${VELO_LOCAL_MINIO_CONSOLE_PORT:-$(get_free_port)}"
  if [ -z "${VELO_LOCAL_WEB_PORT:-}" ]; then
    if port_is_free 3000; then
      export VELO_LOCAL_WEB_PORT=3000
    else
      export VELO_LOCAL_WEB_PORT="$(get_free_port)"
    fi
  fi
  export VELO_LOCAL_APP_PASSWORD="${VELO_LOCAL_APP_PASSWORD:-velo-local-password}"
  save_env_file
}

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

DEV_SERVER_PID=""
CLEANUP_WATCHER_PID=""

start_cleanup_watcher() {
  local parent_pid="$$"

  if [ -n "$CLEANUP_WATCHER_PID" ] && kill -0 "$CLEANUP_WATCHER_PID" 2>/dev/null; then
    return
  fi

  nohup perl -MPOSIX=setsid -e 'setsid() or die "setsid: $!"; exec @ARGV' \
    bash -c '
      parent_pid="$1"
      compose_file="$2"
      compose_project_name="$3"

      while kill -0 "$parent_pid" 2>/dev/null; do
        sleep 2
      done

      COMPOSE_PROJECT_NAME="$compose_project_name" docker compose -f "$compose_file" down -v --remove-orphans >/dev/null 2>&1 || true
    ' bash "$parent_pid" "$COMPOSE_FILE" "$COMPOSE_PROJECT_NAME" >/dev/null 2>&1 &
  CLEANUP_WATCHER_PID=$!
}

cleanup_dev() {
  local exit_code=$?

  trap - EXIT INT TERM HUP

  if [ -n "$DEV_SERVER_PID" ] && kill -0 "$DEV_SERVER_PID" 2>/dev/null; then
    kill "$DEV_SERVER_PID" 2>/dev/null || true
    wait "$DEV_SERVER_PID" 2>/dev/null || true
  fi

  compose down -v --remove-orphans || true

  if [ -n "$CLEANUP_WATCHER_PID" ] && kill -0 "$CLEANUP_WATCHER_PID" 2>/dev/null; then
    kill "$CLEANUP_WATCHER_PID" 2>/dev/null || true
    wait "$CLEANUP_WATCHER_PID" 2>/dev/null || true
  fi

  exit "$exit_code"
}

ensure_minio_certs() {
  local cert_dir="$ROOT_DIR/.velo/minio-certs"
  mkdir -p "$cert_dir"

  if [ -f "$cert_dir/public.crt" ] && [ -f "$cert_dir/private.key" ]; then
    return
  fi

  local config_file="$cert_dir/openssl.cnf"
  cat > "$config_file" <<'CONF'
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = minio

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = minio
DNS.2 = localhost
IP.1 = 127.0.0.1
CONF

  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout "$cert_dir/private.key" \
    -out "$cert_dir/public.crt" \
    -config "$config_file" >/dev/null 2>&1
  rm -f "$config_file"
}

ensure_minio_bucket() {
  compose exec -T minio sh -lc 'mc --insecure alias set local https://localhost:9000 minioadmin minioadmin >/dev/null && mc --insecure mb -p local/velo-dev >/dev/null 2>&1 || true'
}

wait_for_postgres() {
  local service="$1"
  for _ in $(seq 1 60); do
    if compose exec -T "$service" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "$service did not become ready" >&2
  return 1
}

seed_prod() {
  compose exec -T prod-postgres psql -U postgres -d postgres <<'SQL'
create table if not exists velo_local_notes (
  id serial primary key,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists velo_local_accounts (
  id serial primary key,
  account_key text not null unique,
  company_name text not null,
  plan text not null,
  seats integer not null,
  balance numeric(12,2) not null,
  active boolean not null,
  tags text[] not null,
  metadata jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists velo_local_events (
  id bigserial primary key,
  account_key text not null,
  event_name text not null,
  event_index integer not null,
  score double precision not null,
  payload jsonb not null,
  happened_at timestamptz not null
);

create table if not exists velo_local_wide_profiles (
  id serial primary key,
  external_id text not null unique,
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text,
  company text not null,
  job_title text not null,
  department text not null,
  country text not null,
  region text not null,
  city text not null,
  postal_code text not null,
  address_line_1 text not null,
  address_line_2 text,
  latitude numeric(9,6) not null,
  longitude numeric(9,6) not null,
  signup_date date not null,
  last_seen_at timestamptz not null,
  login_count integer not null,
  lifetime_value numeric(12,2) not null,
  is_active boolean not null,
  is_admin boolean not null,
  preferred_locale text not null,
  timezone text not null,
  tags text[] not null,
  settings jsonb not null,
  notes text,
  risk_score double precision not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists velo_local_mixed_types (
  id serial primary key,
  sample_uuid uuid not null,
  sample_text text not null,
  sample_varchar varchar(24) not null,
  sample_integer integer not null,
  sample_bigint bigint not null,
  sample_numeric numeric(10,4) not null,
  sample_double double precision not null,
  sample_boolean boolean not null,
  sample_date date not null,
  sample_time time not null,
  sample_timestamp timestamp not null,
  sample_timestamptz timestamptz not null,
  sample_json jsonb not null,
  sample_array text[] not null,
  sample_inet inet not null
);

insert into velo_local_notes (body)
select 'hello from local prod'
where not exists (select 1 from velo_local_notes);

insert into velo_local_accounts (account_key, company_name, plan, seats, balance, active, tags, metadata, created_at, updated_at)
select
  'acct-' || item,
  'Company ' || item,
  case when item % 3 = 0 then 'enterprise' when item % 3 = 1 then 'team' else 'free' end,
  5 + item,
  (item * 137.42)::numeric(12,2),
  item % 4 <> 0,
  array['local', 'seed', 'tier-' || (item % 3)],
  jsonb_build_object('source', 'local', 'priority', item % 5, 'owner', 'user-' || item),
  now() - (item || ' days')::interval,
  now() - (item || ' hours')::interval
from generate_series(1, 12) as item
where not exists (select 1 from velo_local_accounts);

insert into velo_local_events (account_key, event_name, event_index, score, payload, happened_at)
select
  'acct-' || ((item % 12) + 1),
  case when item % 5 = 0 then 'branch.created' when item % 5 = 1 then 'query.run' when item % 5 = 2 then 'backup.completed' when item % 5 = 3 then 'restore.previewed' else 'user.invited' end,
  item,
  round((random() * 100)::numeric, 3)::double precision,
  jsonb_build_object('index', item, 'ok', item % 7 <> 0, 'batch', item / 100),
  now() - (item || ' minutes')::interval
from generate_series(1, 3000) as item
where not exists (select 1 from velo_local_events);

insert into velo_local_wide_profiles (
  external_id,
  first_name,
  last_name,
  email,
  phone,
  company,
  job_title,
  department,
  country,
  region,
  city,
  postal_code,
  address_line_1,
  address_line_2,
  latitude,
  longitude,
  signup_date,
  last_seen_at,
  login_count,
  lifetime_value,
  is_active,
  is_admin,
  preferred_locale,
  timezone,
  tags,
  settings,
  notes,
  risk_score,
  created_at,
  updated_at
)
select
  'profile-' || item,
  'First' || item,
  'Last' || item,
  'person' || item || '@example.test',
  '+1-555-010' || item,
  'Company ' || ((item % 12) + 1),
  case when item % 2 = 0 then 'Engineer' else 'Designer' end,
  case when item % 3 = 0 then 'Product' when item % 3 = 1 then 'Data' else 'Ops' end,
  'US',
  'CA',
  'San Francisco',
  '9410' || (item % 10),
  item || ' Market St',
  null,
  37.700000 + (item * 0.001),
  -122.400000 - (item * 0.001),
  current_date - item,
  now() - (item || ' hours')::interval,
  item * 3,
  (item * 42.75)::numeric(12,2),
  item % 5 <> 0,
  item = 1,
  'en-US',
  'America/Los_Angeles',
  array['wide', 'profile', 'group-' || (item % 4)],
  jsonb_build_object('theme', case when item % 2 = 0 then 'light' else 'dark' end, 'email_updates', item % 3 <> 0),
  'seed profile ' || item,
  round((random() * 10)::numeric, 2)::double precision,
  now() - (item || ' days')::interval,
  now() - (item || ' minutes')::interval
from generate_series(1, 40) as item
where not exists (select 1 from velo_local_wide_profiles);

insert into velo_local_mixed_types (
  sample_uuid,
  sample_text,
  sample_varchar,
  sample_integer,
  sample_bigint,
  sample_numeric,
  sample_double,
  sample_boolean,
  sample_date,
  sample_time,
  sample_timestamp,
  sample_timestamptz,
  sample_json,
  sample_array,
  sample_inet
)
select
  ('00000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
  'mixed row ' || item,
  'varchar-' || item,
  item,
  item * 1000000000::bigint,
  (item * 12.3456)::numeric(10,4),
  item / 3.0,
  item % 2 = 0,
  current_date - item,
  ('08:00:00'::time + (item || ' minutes')::interval)::time,
  (now() - (item || ' days')::interval)::timestamp,
  now() - (item || ' hours')::interval,
  jsonb_build_object('row', item, 'nested', jsonb_build_object('enabled', item % 2 = 0)),
  array['alpha', 'beta', 'item-' || item],
  ('10.0.0.' || item)::inet
from generate_series(1, 10) as item
where not exists (select 1 from velo_local_mixed_types);

analyze velo_local_notes;
analyze velo_local_accounts;
analyze velo_local_events;
analyze velo_local_wide_profiles;
analyze velo_local_mixed_types;
SQL
}

seed_pgbackrest() {
  compose exec -T --user postgres prod-postgres sh -lc 'pgbackrest --config=/etc/pgbackrest.conf --stanza=main stanza-create || pgbackrest --config=/etc/pgbackrest.conf --stanza=main info'
  compose exec -T --user postgres prod-postgres sh -lc 'pgbackrest --config=/etc/pgbackrest.conf --stanza=main check'
  compose exec -T --user postgres prod-postgres sh -lc 'pgbackrest --config=/etc/pgbackrest.conf --stanza=main backup --type=full'
  compose exec -T prod-postgres psql -U postgres -d postgres <<'SQL'
insert into velo_local_notes (body)
select 'hello after local full backup'
where not exists (select 1 from velo_local_notes where body = 'hello after local full backup');
select pg_switch_wal();
SQL
}

up() {
  ensure_ports
  ensure_minio_certs
  compose up -d --build
  wait_for_postgres prod-postgres
  wait_for_postgres dev-postgres
  ensure_minio_bucket
  seed_prod
  seed_pgbackrest
  bun run db:migrate
  APP_PASSWORD="$VELO_LOCAL_APP_PASSWORD" bun run auth:set-password
  bun run src/server/local-docker-seed.ts
}

dev() {
  trap cleanup_dev EXIT INT TERM HUP

  start_cleanup_watcher
  up
  bun --bun vite dev --host 0.0.0.0 --port "$VELO_LOCAL_WEB_PORT" &
  DEV_SERVER_PID=$!
  wait "$DEV_SERVER_PID"
}

case "${1:-up}" in
  up)
    up
    ;;
  dev)
    dev
    ;;
  down)
    ensure_ports
    compose down
    ;;
  reset)
    ensure_ports
    compose down -v
    rm -f "$LOCAL_DB" "$LOCAL_DB-shm" "$LOCAL_DB-wal"
    up
    ;;
  status)
    ensure_ports
    compose ps
    printf '\napp: http://localhost:%s\n' "$VELO_LOCAL_WEB_PORT"
    printf 'auth: skipped on localhost\n'
    printf 'prod: postgresql://postgres:postgres@localhost:%s/postgres?sslmode=disable\n' "$VELO_LOCAL_PROD_PORT"
    printf 'dev:  postgresql://postgres:postgres@localhost:%s/postgres?sslmode=disable\n' "$VELO_LOCAL_DEV_PORT"
    printf 's3:   https://localhost:%s\n' "$VELO_LOCAL_MINIO_PORT"
    ;;
  *)
    echo "usage: bun run local:up|local:dev|local:down|local:reset|local:status" >&2
    exit 1
    ;;
esac
