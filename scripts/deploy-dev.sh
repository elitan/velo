#!/usr/bin/env bash
set -euo pipefail

VELO_DEPLOY_HOST="${VELO_DEPLOY_HOST:?Set VELO_DEPLOY_HOST}"
VELO_DEPLOY_USER="${VELO_DEPLOY_USER:-root}"
VELO_DEPLOY_KEY="${VELO_DEPLOY_KEY:-$HOME/.ssh/frost-e2e-ci}"
VELO_DEPLOY_DIR="${VELO_DEPLOY_DIR:-/opt/velo}"
VELO_HOST="${VELO_HOST:-0.0.0.0}"
VELO_PORT="${VELO_PORT:-3000}"
VELO_DB="${VELO_DB:-$VELO_DEPLOY_DIR/.velo/velo.sqlite}"
VELO_PUBLIC_URL="${VELO_PUBLIC_URL:-http://$VELO_DEPLOY_HOST:$VELO_PORT}"

SSH_ARGS=(
  -i "$VELO_DEPLOY_KEY"
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
)

REMOTE="$VELO_DEPLOY_USER@$VELO_DEPLOY_HOST"

echo "Deploying Velo to $REMOTE:$VELO_DEPLOY_DIR"

ssh "${SSH_ARGS[@]}" "$REMOTE" "mkdir -p '$VELO_DEPLOY_DIR'"

rsync -az --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude .velo \
  --exclude dist \
  --exclude .env \
  -e "ssh -i $VELO_DEPLOY_KEY -o StrictHostKeyChecking=accept-new" \
  ./ "$REMOTE:$VELO_DEPLOY_DIR/"

ssh "${SSH_ARGS[@]}" "$REMOTE" "set -e
cd '$VELO_DEPLOY_DIR'
export BUN_INSTALL=/root/.bun
export PATH=\"\$BUN_INSTALL/bin:\$PATH\"

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi

bun install --frozen-lockfile
VELO_DB='$VELO_DB' bun run db:migrate
bun run web:build

if [ ! -f /etc/velo.env ]; then
  umask 077
  printf 'BETTER_AUTH_SECRET=%s\n' \"\$(openssl rand -base64 48)\" >/etc/velo.env
fi

grep -q '^BETTER_AUTH_URL=' /etc/velo.env || printf 'BETTER_AUTH_URL=%s\n' '$VELO_PUBLIC_URL' >>/etc/velo.env

cat >/etc/systemd/system/velo-web.service <<SERVICE
[Unit]
Description=Velo web UI
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$VELO_DEPLOY_DIR
Environment=HOST=$VELO_HOST
Environment=PORT=$VELO_PORT
Environment=VELO_DB=$VELO_DB
Environment=NODE_ENV=production
EnvironmentFile=/etc/velo.env
ExecStart=/root/.bun/bin/bun src/server/web-runtime.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable velo-web >/dev/null
systemctl stop velo-web || true

if ss -ltnp | grep -q ':$VELO_PORT '; then
  ss -ltnp | awk '/:$VELO_PORT / { print \$0 }'
  ss -ltnp | awk '/:$VELO_PORT / { match(\$0, /pid=[0-9]+/); if (RSTART) print substr(\$0, RSTART + 4, RLENGTH - 4) }' | xargs -r kill
  sleep 1
fi

systemctl start velo-web
sleep 1
systemctl is-active --quiet velo-web
"

curl -fsS -I "http://$VELO_DEPLOY_HOST:$VELO_PORT" >/dev/null
echo "Deployed: http://$VELO_DEPLOY_HOST:$VELO_PORT"
