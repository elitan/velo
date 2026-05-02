#!/usr/bin/env bash
set -Eeuo pipefail

VELO_DEPLOY_DEV_HOST="${VELO_DEPLOY_DEV_HOST:?Set VELO_DEPLOY_DEV_HOST}"
VELO_DEPLOY_PROD_HOST="${VELO_DEPLOY_PROD_HOST:?Set VELO_DEPLOY_PROD_HOST}"
VELO_DEPLOY_USER="${VELO_DEPLOY_USER:-root}"
VELO_DEPLOY_KEY="${VELO_DEPLOY_KEY:?Set VELO_DEPLOY_KEY}"
VELO_DEPLOY_DIR="${VELO_DEPLOY_DIR:-/opt/velo}"
VELO_PORT="${VELO_PORT:-3000}"

SSH_ARGS=(
  -i "$VELO_DEPLOY_KEY"
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=8
)

APP_REMOTE="$VELO_DEPLOY_USER@$VELO_DEPLOY_DEV_HOST"
PROD_REMOTE="$VELO_DEPLOY_USER@$VELO_DEPLOY_PROD_HOST"

ssh_run() {
  local remote="$1"
  local command="$2"

  ssh "${SSH_ARGS[@]}" "$remote" "$command"
}

shell_quote() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

print_debug() {
  echo "app server logs"
  ssh_run "$APP_REMOTE" "systemctl status velo-web --no-pager -l || true; journalctl -u velo-web -n 160 --no-pager || true" || true
  echo "database server logs"
  ssh_run "$PROD_REMOTE" "systemctl status postgresql --no-pager -l || true; journalctl -u postgresql -n 160 --no-pager || true" || true
}

create_dev_branch() {
  ssh_run "$APP_REMOTE" "
set -e
cd $(shell_quote "$VELO_DEPLOY_DIR")
VELO_DB=$(shell_quote "$VELO_DEPLOY_DIR/.velo/velo.sqlite") /root/.bun/bin/bun -e '
import { createReplicaBase } from \"./src/server/services/replica-service.ts\";
import { createBranchFromBase } from \"./src/server/services/branch-service.ts\";

function assertOk(result) {
  if (!result.ok) {
    throw new Error(result.message);
  }
}

assertOk(await createReplicaBase());
await createBranchFromBase({ name: \"dev\", slug: \"dev\", parentBranchId: null });
'
"
}

check_dev_branch() {
  ssh_run "$APP_REMOTE" "
set -e
cd $(shell_quote "$VELO_DEPLOY_DIR")
CONNECTION_URL=\$(VELO_DB=$(shell_quote "$VELO_DEPLOY_DIR/.velo/velo.sqlite") /root/.bun/bin/bun -e '
import { Database } from \"bun:sqlite\";

const db = new Database(process.env.VELO_DB);
const branch = db.query(\"select slug, status, connection_url from branches where slug = ?\").get(\"dev\");
const steps = db.query(\"select key, status from setup_steps where key in (?, ?) order by key\").all(\"replica\", \"first-branch\");

if (!branch || branch.status !== \"running\" || !branch.connection_url) {
  throw new Error(\"bad dev branch: \" + JSON.stringify(branch));
}

if (steps.length !== 2 || steps.some(function isBad(step) { return step.status !== \"done\"; })) {
  throw new Error(\"bad branch setup steps: \" + JSON.stringify(steps));
}

console.log(branch.connection_url);
db.close();
')
psql \"\$CONNECTION_URL\" -tAc 'select 1' | grep -qx 1
set -a
. /etc/velo.env
set +a
curl -fsS -I -u \"\$VELO_BASIC_AUTH_USERNAME:\$VELO_BASIC_AUTH_PASSWORD\" http://127.0.0.1:$VELO_PORT/branch/dev/overview >/dev/null
"
}

main() {
  trap print_debug ERR

  echo "Deploying fresh Hetzner app and prod database"
  scripts/deploy-hetzner.sh

  echo "Creating dev branch through product services"
  create_dev_branch

  echo "Checking dev branch"
  check_dev_branch

  echo "Hetzner E2E passed"
}

main "$@"
