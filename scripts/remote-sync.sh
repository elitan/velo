#!/usr/bin/env bash
set -euo pipefail

VELO_REMOTE_HOST="${VELO_REMOTE_HOST:-${VELO_DEPLOY_HOST:?Set VELO_REMOTE_HOST or VELO_DEPLOY_HOST}}"
VELO_REMOTE_USER="${VELO_REMOTE_USER:-${VELO_DEPLOY_USER:-root}}"
VELO_REMOTE_KEY="${VELO_REMOTE_KEY:-${VELO_DEPLOY_KEY:-$HOME/.ssh/frost-e2e-ci}}"
VELO_REMOTE_DIR="${VELO_REMOTE_DIR:-/opt/velo-dev}"

SSH_ARGS=(
  -i "$VELO_REMOTE_KEY"
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
)

RSYNC_SSH="ssh -i $VELO_REMOTE_KEY -o StrictHostKeyChecking=accept-new"
REMOTE="$VELO_REMOTE_USER@$VELO_REMOTE_HOST"

sync_once() {
  ssh "${SSH_ARGS[@]}" "$REMOTE" "mkdir -p '$VELO_REMOTE_DIR'"
  rsync -az --delete \
    --exclude .git \
    --exclude node_modules \
    --exclude .velo \
    --exclude dist \
    --exclude .env \
    --exclude .tanstack \
    --exclude '*.tsbuildinfo' \
    -e "$RSYNC_SSH" \
    ./ "$REMOTE:$VELO_REMOTE_DIR/"
}

if [ "${1:-}" = "--once" ]; then
  sync_once
  echo "Synced to $REMOTE:$VELO_REMOTE_DIR"
  exit 0
fi

echo "Watching local files. Syncing to $REMOTE:$VELO_REMOTE_DIR"
echo "Press Ctrl+C to stop."

while true; do
  sync_once >/dev/null
  sleep "${VELO_SYNC_INTERVAL:-1}"
done
