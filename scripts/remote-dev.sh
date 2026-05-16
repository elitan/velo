#!/usr/bin/env bash
set -euo pipefail

VELO_REMOTE_HOST="${VELO_REMOTE_HOST:-${VELO_DEPLOY_HOST:?Set VELO_REMOTE_HOST or VELO_DEPLOY_HOST}}"
VELO_REMOTE_USER="${VELO_REMOTE_USER:-${VELO_DEPLOY_USER:-root}}"
VELO_REMOTE_KEY="${VELO_REMOTE_KEY:-${VELO_DEPLOY_KEY:-$HOME/.ssh/frost-e2e-ci}}"
VELO_REMOTE_DIR="${VELO_REMOTE_DIR:-/opt/velo-dev}"
VELO_DATA_DIR="${VELO_DATA_DIR:-/opt/velo}"
VELO_HOST="${VELO_HOST:-0.0.0.0}"
VELO_PORT="${VELO_PORT:-3000}"
VELO_DB="${VELO_DB:-$VELO_DATA_DIR/.velo/velo.sqlite}"
VELO_PUBLIC_URL="${VELO_PUBLIC_URL:-http://$VELO_REMOTE_HOST:$VELO_PORT}"

SSH_ARGS=(
  -i "$VELO_REMOTE_KEY"
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
)

REMOTE="$VELO_REMOTE_USER@$VELO_REMOTE_HOST"

echo "Starting remote dev server on $REMOTE:$VELO_REMOTE_DIR"
"$(dirname "$0")/remote-sync.sh" --once

ssh "${SSH_ARGS[@]}" "$REMOTE" "set -e
cd '$VELO_REMOTE_DIR'
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
go build -o /usr/local/bin/velo-proxy ./cmd/velo-proxy

if [ ! -f /etc/velo.env ]; then
  umask 077
  printf 'BETTER_AUTH_SECRET=%s\n' \"\$(openssl rand -base64 48)\" >/etc/velo.env
fi

grep -q '^BETTER_AUTH_URL=' /etc/velo.env || printf 'BETTER_AUTH_URL=%s\n' '$VELO_PUBLIC_URL' >>/etc/velo.env
grep -q '^VELO_INTERNAL_TOKEN=' /etc/velo.env || printf 'VELO_INTERNAL_TOKEN=%s\n' \"\$(openssl rand -base64 48)\" >>/etc/velo.env

cat >/etc/systemd/system/velo-web-dev.service <<SERVICE
[Unit]
Description=Velo remote dev UI
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$VELO_REMOTE_DIR
Environment=HOST=$VELO_HOST
Environment=PORT=$VELO_PORT
Environment=VELO_DB=$VELO_DB
Environment=NODE_ENV=development
EnvironmentFile=/etc/velo.env
ExecStart=/root/.bun/bin/bun --bun vite dev --host $VELO_HOST --port $VELO_PORT --strictPort
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
SERVICE

cat >/etc/systemd/system/velo-proxy.service <<SERVICE
[Unit]
Description=Velo branch TCP proxy
After=network-online.target docker.service velo-web-dev.service
Wants=network-online.target
Requires=velo-web-dev.service

[Service]
Type=simple
WorkingDirectory=$VELO_REMOTE_DIR
Environment=VELO_INTERNAL_API_URL=http://127.0.0.1:$VELO_PORT/internal
Environment=VELO_PROXY_BIND=127.0.0.1
Environment=VELO_PROXY_IDLE_SECONDS=1800
EnvironmentFile=/etc/velo.env
ExecStart=/usr/local/bin/velo-proxy
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl stop velo-web || true
systemctl enable velo-web-dev >/dev/null
systemctl enable velo-proxy >/dev/null
systemctl restart velo-web-dev
systemctl restart velo-proxy

for attempt in \$(seq 1 30); do
  if curl -fsS -I 'http://127.0.0.1:$VELO_PORT' >/dev/null 2>&1; then
    systemctl is-active --quiet velo-web-dev
    systemctl is-active --quiet velo-proxy
    exit 0
  fi
  sleep 1
done

systemctl status velo-web-dev --no-pager -l || true
journalctl -u velo-web-dev -n 80 --no-pager || true
exit 1
"

curl -fsS -I "http://$VELO_REMOTE_HOST:$VELO_PORT" >/dev/null
echo "Remote dev ready: http://$VELO_REMOTE_HOST:$VELO_PORT"
