#!/usr/bin/env bash
set -Eeuo pipefail

VELO_TEST_DEV_HOST="${VELO_TEST_DEV_HOST:-157.180.22.136}"
VELO_TEST_PROD_HOST="${VELO_TEST_PROD_HOST:-89.167.89.255}"
VELO_TEST_USER="${VELO_TEST_USER:-root}"
VELO_TEST_KEY="${VELO_TEST_KEY:-$HOME/.ssh/frost-e2e-ci}"
VELO_REPO="${VELO_REPO:-https://github.com/elitan/velo.git}"
VELO_REF="${VELO_REF:-$(git rev-parse HEAD)}"
VELO_PORT="${VELO_PORT:-3000}"
VELO_DEV_DIR="${VELO_DEV_DIR:-/opt/velo}"
VELO_REMOTE_KEY_PATH="${VELO_REMOTE_KEY_PATH:-/root/.ssh/frost-e2e-ci}"

SSH_ARGS=(
  -i "$VELO_TEST_KEY"
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=8
)

DEV_REMOTE="$VELO_TEST_USER@$VELO_TEST_DEV_HOST"
PROD_REMOTE="$VELO_TEST_USER@$VELO_TEST_PROD_HOST"

shell_quote() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

ssh_run() {
  local remote="$1"
  local command="$2"

  ssh "${SSH_ARGS[@]}" "$remote" "$command"
}

copy_file() {
  local source="$1"
  local remote="$2"
  local target="$3"

  scp "${SSH_ARGS[@]}" "$source" "$remote:$target"
}

reset_dev_server() {
  ssh_run "$DEV_REMOTE" "
set -e
systemctl stop velo-web velo-web-dev >/dev/null 2>&1 || true
systemctl disable velo-web velo-web-dev >/dev/null 2>&1 || true
rm -f /etc/systemd/system/velo-web.service /etc/systemd/system/velo-web-dev.service
systemctl daemon-reload
if ss -ltnp | grep -q ':$VELO_PORT '; then
  ss -ltnp | awk '/:$VELO_PORT / { match(\$0, /pid=[0-9]+/); if (RSTART) print substr(\$0, RSTART + 4, RLENGTH - 4) }' | xargs -r kill
fi
docker ps -aq --filter name=velo | xargs -r docker rm -f >/dev/null 2>&1 || true
docker volume ls -q | grep '^velo' | xargs -r docker volume rm -f >/dev/null 2>&1 || true
if command -v zfs >/dev/null 2>&1; then
  zfs destroy -r tank/velo >/dev/null 2>&1 || true
  zpool destroy tank >/dev/null 2>&1 || true
fi
rm -rf $(shell_quote "$VELO_DEV_DIR") /opt/velo-dev /root/.velo /etc/velo.env /var/lib/velo/zfs-pool.img
"
}

reset_prod_server() {
  ssh_run "$PROD_REMOTE" "
set -e
systemctl stop postgresql >/dev/null 2>&1 || true
if command -v pg_lsclusters >/dev/null 2>&1; then
  pg_lsclusters --no-header | while read -r version cluster _rest; do
    pg_dropcluster --stop \"\$version\" \"\$cluster\" >/dev/null 2>&1 || true
  done
fi
rm -rf /var/lib/pgbackrest /var/log/pgbackrest /etc/pgbackrest.conf /etc/cron.d/velo-pgbackrest
if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-contrib pgbackrest
fi
pg_version=\$(ls /usr/lib/postgresql 2>/dev/null | sort -V | tail -1)
if [ -n \"\$pg_version\" ] && ! pg_lsclusters --no-header | awk '{ print \$2 }' | grep -qx main; then
  pg_createcluster \"\$pg_version\" main --start
fi
systemctl enable --now postgresql >/dev/null
"
}

install_dev_server() {
  ssh_run "$DEV_REMOTE" "mkdir -p $(shell_quote "$(dirname "$VELO_REMOTE_KEY_PATH")")"
  copy_file scripts/install.sh "$DEV_REMOTE" /tmp/velo-install.sh
  copy_file "$VELO_TEST_KEY" "$DEV_REMOTE" "$VELO_REMOTE_KEY_PATH"

  ssh_run "$DEV_REMOTE" "
set -e
chmod 600 $(shell_quote "$VELO_REMOTE_KEY_PATH")
VELO_DIR=$(shell_quote "$VELO_DEV_DIR") \\
VELO_REPO=$(shell_quote "$VELO_REPO") \\
VELO_REF=$(shell_quote "$VELO_REF") \\
VELO_HOST=0.0.0.0 \\
VELO_PORT=$(shell_quote "$VELO_PORT") \\
VELO_PUBLIC_URL=$(shell_quote "http://$VELO_TEST_DEV_HOST:$VELO_PORT") \\
bash /tmp/velo-install.sh
"
}

seed_app_config() {
  ssh_run "$DEV_REMOTE" "
set -e
cd $(shell_quote "$VELO_DEV_DIR")
VELO_DB=$(shell_quote "$VELO_DEV_DIR/.velo/velo.sqlite") \\
DEV_HOST=$(shell_quote "$VELO_TEST_DEV_HOST") \\
PROD_HOST=$(shell_quote "$VELO_TEST_PROD_HOST") \\
SSH_USER=$(shell_quote "$VELO_TEST_USER") \\
SSH_KEY_PATH=$(shell_quote "$VELO_REMOTE_KEY_PATH") \\
/root/.bun/bin/bun -e '
import { Database } from \"bun:sqlite\";

const db = new Database(process.env.VELO_DB);
const saveServer = db.prepare(
  \"insert into servers (role, host, ssh_user, ssh_key_path, status, status_message, last_checked_at) \" +
  \"values (?, ?, ?, ?, ?, null, null) \" +
  \"on conflict(role) do update set \" +
  \"host = excluded.host, \" +
  \"ssh_user = excluded.ssh_user, \" +
  \"ssh_key_path = excluded.ssh_key_path, \" +
  \"status = excluded.status, \" +
  \"status_message = null, \" +
  \"last_checked_at = null, \" +
  \"updated_at = current_timestamp\"
);

saveServer.run(\"dev\", process.env.DEV_HOST, process.env.SSH_USER, process.env.SSH_KEY_PATH, \"unknown\");
saveServer.run(\"prod\", process.env.PROD_HOST, process.env.SSH_USER, process.env.SSH_KEY_PATH, \"unknown\");
db.close();
'
"
}

bootstrap_servers() {
  ssh_run "$DEV_REMOTE" "
set -e
cd $(shell_quote "$VELO_DEV_DIR")
VELO_DB=$(shell_quote "$VELO_DEV_DIR/.velo/velo.sqlite") /root/.bun/bin/bun -e '
import { checkServer } from \"./src/server/services/setup-state-service.ts\";
import { runDevBootstrap, runProdBootstrap } from \"./src/server/services/bootstrap-service.ts\";

function assertOk(result) {
  if (!result.ok) {
    throw new Error(result.message);
  }
}

await checkServer(\"dev\");
await checkServer(\"prod\");
assertOk(await runDevBootstrap());
assertOk(await runProdBootstrap());
'
systemctl restart velo-web
"
}

check_servers() {
  local attempt

  for attempt in $(seq 1 30); do
    if curl -fsS -I "http://$VELO_TEST_DEV_HOST:$VELO_PORT" >/dev/null 2>&1; then
      break
    fi

    if [ "$attempt" = 30 ]; then
      curl -fsS -I "http://$VELO_TEST_DEV_HOST:$VELO_PORT" >/dev/null
    fi

    sleep 1
  done

  ssh_run "$DEV_REMOTE" "
set -e
systemctl is-active --quiet velo-web
cd $(shell_quote "$VELO_DEV_DIR")
VELO_DB=$(shell_quote "$VELO_DEV_DIR/.velo/velo.sqlite") /root/.bun/bin/bun -e '
import { Database } from \"bun:sqlite\";

const db = new Database(process.env.VELO_DB);
const servers = db.query(\"select role, status from servers order by role\").all();
const steps = db.query(\"select key, status from setup_steps where key in (?, ?, ?, ?) order by key\").all(
  \"dev-check\",
  \"prod-check\",
  \"prod-setup\",
  \"backups\"
);

if (servers.length !== 2 || servers.some(function isBad(server) { return server.status !== \"ok\"; })) {
  throw new Error(\"bad servers: \" + JSON.stringify(servers));
}

if (steps.length !== 4 || steps.some(function isBad(step) { return step.status !== \"done\"; })) {
  throw new Error(\"bad setup steps: \" + JSON.stringify(steps));
}

db.close();
'
"

  ssh_run "$PROD_REMOTE" "
set -e
systemctl is-active --quiet postgresql
sudo -u postgres pg_isready -d postgres >/dev/null
sudo -u postgres pgbackrest --stanza=main info >/dev/null
"
}

print_debug() {
  echo "dev server logs"
  ssh_run "$DEV_REMOTE" "systemctl status velo-web --no-pager -l || true; journalctl -u velo-web -n 120 --no-pager || true" || true
  echo "prod server logs"
  ssh_run "$PROD_REMOTE" "systemctl status postgresql --no-pager -l || true; journalctl -u postgresql -n 120 --no-pager || true" || true
}

main() {
  trap print_debug ERR

  echo "Resetting dev server $VELO_TEST_DEV_HOST"
  reset_dev_server

  echo "Resetting prod server $VELO_TEST_PROD_HOST"
  reset_prod_server

  echo "Installing Velo $VELO_REF on dev server"
  install_dev_server

  echo "Saving test server config"
  seed_app_config

  echo "Bootstrapping test servers"
  bootstrap_servers

  echo "Checking test servers"
  check_servers

  echo "Deployed fresh test servers: http://$VELO_TEST_DEV_HOST:$VELO_PORT"
}

main "$@"
