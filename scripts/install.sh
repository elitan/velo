#!/usr/bin/env bash
set -euo pipefail

VELO_PORT="${VELO_PORT:-3000}"
VELO_HOST="${VELO_HOST:-0.0.0.0}"
VELO_DIR="${VELO_DIR:-/opt/velo}"
VELO_REPO="${VELO_REPO:-https://github.com/elitan/velo.git}"
VELO_REF="${VELO_REF:-main}"
VELO_PUBLIC_URL="${VELO_PUBLIC_URL:-http://$VELO_HOST:$VELO_PORT}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root."
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "Only Ubuntu/Debian is supported in the MVP installer."
  exit 1
fi

if ! command -v curl >/dev/null 2>&1 ||
  ! command -v git >/dev/null 2>&1 ||
  ! command -v unzip >/dev/null 2>&1 ||
  ! command -v docker >/dev/null 2>&1 ||
  ! command -v zfs >/dev/null 2>&1 ||
  ! command -v psql >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y curl git unzip docker.io zfsutils-linux postgresql-client
fi
systemctl enable --now docker || true

export BUN_INSTALL="${BUN_INSTALL:-/root/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

mkdir -p "$VELO_DIR"
if [ ! -d "$VELO_DIR/.git" ]; then
  git clone "$VELO_REPO" "$VELO_DIR"
fi

cd "$VELO_DIR"
git fetch --all --tags
git checkout "$VELO_REF"
git reset --hard "$VELO_REF"
git clean -fd -e node_modules -e .velo
bun install --frozen-lockfile
VELO_DB="$VELO_DIR/.velo/velo.sqlite" bun run db:migrate
bun run web:build

if [ ! -f /etc/velo.env ]; then
  umask 077
  printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -base64 48)" >/etc/velo.env
fi

grep -q '^BETTER_AUTH_URL=' /etc/velo.env || printf 'BETTER_AUTH_URL=%s\n' "$VELO_PUBLIC_URL" >>/etc/velo.env
grep -q '^VELO_BASIC_AUTH_USERNAME=' /etc/velo.env || printf 'VELO_BASIC_AUTH_USERNAME=%s\n' "${VELO_BASIC_AUTH_USERNAME:-velo}" >>/etc/velo.env
grep -q '^VELO_BASIC_AUTH_PASSWORD=' /etc/velo.env || printf 'VELO_BASIC_AUTH_PASSWORD=%s\n' "${VELO_BASIC_AUTH_PASSWORD:-$(openssl rand -base64 32)}" >>/etc/velo.env

cat >/etc/systemd/system/velo-web.service <<SERVICE
[Unit]
Description=Velo web UI
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$VELO_DIR
Environment=HOST=$VELO_HOST
Environment=PORT=$VELO_PORT
Environment=VELO_DB=$VELO_DIR/.velo/velo.sqlite
Environment=NODE_ENV=production
EnvironmentFile=/etc/velo.env
ExecStart=$(command -v bun) src/server/web-runtime.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now velo-web

echo
echo "Velo web UI is starting:"
echo "  http://$VELO_HOST:$VELO_PORT"
