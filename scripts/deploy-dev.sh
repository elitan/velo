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
if ! command -v go >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y golang-go
fi

bun install --frozen-lockfile
VELO_STATE_DIR=\"${VELO_DB%/*}\"
mkdir -p -m 700 \"\$VELO_STATE_DIR\"
chmod 700 \"\$VELO_STATE_DIR\"
VELO_DB='$VELO_DB' bun run db:migrate
bun run web:build
go build -o /usr/local/bin/velo-proxy ./cmd/velo-proxy

if [ ! -f /etc/velo.env ]; then
  umask 077
  printf 'BETTER_AUTH_SECRET=%s\n' \"\$(openssl rand -base64 48)\" >/etc/velo.env
fi

grep -q '^BETTER_AUTH_URL=' /etc/velo.env || printf 'BETTER_AUTH_URL=%s\n' '$VELO_PUBLIC_URL' >>/etc/velo.env
grep -q '^VELO_INTERNAL_TOKEN=' /etc/velo.env || printf 'VELO_INTERNAL_TOKEN=%s\n' \"\$(openssl rand -base64 48)\" >>/etc/velo.env
sed -i '/^VELO_BASIC_AUTH_USERNAME=/d; /^VELO_BASIC_AUTH_PASSWORD=/d' /etc/velo.env

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

cat >/etc/systemd/system/velo-proxy.service <<SERVICE
[Unit]
Description=Velo branch TCP proxy
After=network-online.target docker.service velo-web.service
Wants=network-online.target
Requires=velo-web.service

[Service]
Type=simple
WorkingDirectory=$VELO_DEPLOY_DIR
Environment=VELO_INTERNAL_API_URL=http://127.0.0.1:$VELO_PORT/internal
Environment=VELO_PROXY_BIND=127.0.0.1
Environment=VELO_PROXY_IDLE_SECONDS=1800
EnvironmentFile=/etc/velo.env
ExecStart=/usr/local/bin/velo-proxy
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable velo-web >/dev/null
systemctl enable velo-proxy >/dev/null
systemctl stop velo-web || true
systemctl stop velo-proxy || true

if ss -ltnp | grep -q ':$VELO_PORT '; then
  ss -ltnp | awk '/:$VELO_PORT / { print \$0 }'
  ss -ltnp | awk '/:$VELO_PORT / { match(\$0, /pid=[0-9]+/); if (RSTART) print substr(\$0, RSTART + 4, RLENGTH - 4) }' | xargs -r kill
  sleep 1
fi

systemctl start velo-web
systemctl start velo-proxy
sleep 1
systemctl is-active --quiet velo-web
systemctl is-active --quiet velo-proxy
"

ssh "${SSH_ARGS[@]}" "$REMOTE" "curl -fsS -I 'http://127.0.0.1:$VELO_PORT' >/dev/null"
echo "Deployed: http://$VELO_DEPLOY_HOST:$VELO_PORT"
