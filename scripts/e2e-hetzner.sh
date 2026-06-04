#!/usr/bin/env bash
set -Eeuo pipefail

VELO_DEPLOY_DEV_HOST="${VELO_DEPLOY_DEV_HOST:-${VELO_TEST_DEV_HOST:-157.180.22.136}}"
VELO_DEPLOY_PROD_HOST="${VELO_DEPLOY_PROD_HOST:-${VELO_TEST_PROD_HOST:-89.167.89.255}}"
VELO_DEPLOY_USER="${VELO_DEPLOY_USER:-root}"
VELO_DEPLOY_KEY="${VELO_DEPLOY_KEY:-${VELO_TEST_KEY:-$HOME/.ssh/frost-e2e-ci}}"
VELO_DEPLOY_DIR="${VELO_DEPLOY_DIR:-/opt/velo}"
VELO_E2E_SOURCE_DIR="${VELO_E2E_SOURCE_DIR:-}"
VELO_PORT="${VELO_PORT:-3000}"
VELO_PROXY_E2E_IDLE_SECONDS="${VELO_PROXY_E2E_IDLE_SECONDS:-3}"
VELO_SSH_KNOWN_HOSTS_FILE="${VELO_SSH_KNOWN_HOSTS_FILE:-$HOME/.ssh/known_hosts}"

SSH_ARGS=(
  -i "$VELO_DEPLOY_KEY"
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
  -o UserKnownHostsFile="$VELO_SSH_KNOWN_HOSTS_FILE"
  -o ConnectTimeout=8
)

APP_REMOTE="$VELO_DEPLOY_USER@$VELO_DEPLOY_DEV_HOST"
PROD_REMOTE="$VELO_DEPLOY_USER@$VELO_DEPLOY_PROD_HOST"

ssh_run() {
  local remote="$1"
  local command="$2"

  ssh "${SSH_ARGS[@]}" "$remote" "$command"
}

sync_source() {
  if [ -z "$VELO_E2E_SOURCE_DIR" ]; then
    return
  fi

  echo "Syncing E2E source tree"
  rsync -az --delete \
    --exclude .git \
    --exclude node_modules \
    --exclude .velo \
    --exclude dist \
    --exclude .env \
    --exclude .tanstack \
    --exclude '*.tsbuildinfo' \
    -e "ssh -i $VELO_DEPLOY_KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$VELO_SSH_KNOWN_HOSTS_FILE -o ConnectTimeout=8" \
    "$VELO_E2E_SOURCE_DIR/" "$APP_REMOTE:$VELO_DEPLOY_DIR/"

  ssh_run "$APP_REMOTE" "
set -e
cd $(shell_quote "$VELO_DEPLOY_DIR")
/root/.bun/bin/bun install --frozen-lockfile
VELO_DB=$(shell_quote "$VELO_DEPLOY_DIR/.velo/velo.sqlite") /root/.bun/bin/bun run db:migrate
/root/.bun/bin/bun run web:build
systemctl restart velo-web
"
}

shell_quote() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

print_debug() {
  echo "app server logs"
  ssh_run "$APP_REMOTE" "
systemctl status velo-web --no-pager -l || true
journalctl -u velo-web -n 160 --no-pager || true
docker ps -a || true
zfs list -r tank/velo/databases || true
cd $(shell_quote "$VELO_DEPLOY_DIR") && VELO_DB=$(shell_quote "$VELO_DEPLOY_DIR/.velo/velo.sqlite") /root/.bun/bin/bun -e '
import { Database } from \"bun:sqlite\";
const db = new Database(process.env.VELO_DB);
console.log(\"branches\", db.query(\"select id, slug, status, parent_branch_id from branches order by id\").all());
console.log(\"jobs\", db.query(\"select id, type, status, error from jobs order by id desc limit 10\").all());
db.close();
' || true
" || true
  echo "database server logs"
  ssh_run "$PROD_REMOTE" "systemctl status postgresql --no-pager -l || true; journalctl -u postgresql -n 160 --no-pager || true" || true
}

main() {
  trap print_debug ERR

  echo "Deploying fresh Hetzner app and prod database"
  scripts/deploy-hetzner.sh
  sync_source

  echo "Running Hetzner E2E suite"
  ssh_run "$APP_REMOTE" "
set -e
cd $(shell_quote "$VELO_DEPLOY_DIR")
VELO_DB=$(shell_quote "$VELO_DEPLOY_DIR/.velo/velo.sqlite") \\
VELO_PORT=$(shell_quote "$VELO_PORT") \\
VELO_PROXY_E2E_IDLE_SECONDS=$(shell_quote "$VELO_PROXY_E2E_IDLE_SECONDS") \\
VELO_E2E_RUN_ID=$(shell_quote "${VELO_CI_RUN_ID:-$(date +%s)}") \\
/root/.bun/bin/bun scripts/e2e/hetzner-suite.ts
"

  echo "Hetzner E2E passed"
}

main "$@"
