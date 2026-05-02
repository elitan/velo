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

mkdir -p "$LOCAL_STATE_DIR"

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
BETTER_AUTH_URL=$BETTER_AUTH_URL
BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET
EOF
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
  export BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://localhost:$VELO_LOCAL_WEB_PORT}"
  export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-$(openssl rand -base64 48)}"
  save_env_file
}

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
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

insert into velo_local_notes (body)
select 'hello from local prod'
where not exists (select 1 from velo_local_notes);
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
  bun run src/server/local-docker-seed.ts
}

case "${1:-up}" in
  up)
    up
    ;;
  dev)
    up
    bun --bun vite dev --host 0.0.0.0 --port "$VELO_LOCAL_WEB_PORT"
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
    printf 'prod: postgresql://postgres:postgres@localhost:%s/postgres?sslmode=disable\n' "$VELO_LOCAL_PROD_PORT"
    printf 'dev:  postgresql://postgres:postgres@localhost:%s/postgres?sslmode=disable\n' "$VELO_LOCAL_DEV_PORT"
    printf 's3:   https://localhost:%s\n' "$VELO_LOCAL_MINIO_PORT"
    ;;
  *)
    echo "usage: bun run local:up|local:dev|local:down|local:reset|local:status" >&2
    exit 1
    ;;
esac
