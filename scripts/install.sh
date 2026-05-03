#!/usr/bin/env bash
set -euo pipefail

VELO_PORT="${VELO_PORT:-3000}"
VELO_HOST="${VELO_HOST:-0.0.0.0}"
VELO_DIR="${VELO_DIR:-/opt/velo}"
VELO_REPO="${VELO_REPO:-https://github.com/elitan/velo}"
VELO_REF="${VELO_REF:-}"
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

mkdir -p "$VELO_DIR/.velo"

if [ -n "$VELO_REF" ]; then
  GIT_REPO="$VELO_REPO"
  case "$GIT_REPO" in
    *.git) ;;
    *) GIT_REPO="$GIT_REPO.git" ;;
  esac

  if [ ! -d "$VELO_DIR/.git" ]; then
    rm -rf "$VELO_DIR"
    git clone "$GIT_REPO" "$VELO_DIR"
    mkdir -p "$VELO_DIR/.velo"
  fi

  cd "$VELO_DIR"
  git fetch --all --tags
  git checkout "$VELO_REF"
  git reset --hard "$VELO_REF"
  git clean -fd -e node_modules -e .velo
  bun install --frozen-lockfile
  VELO_DB="$VELO_DIR/.velo/velo.sqlite" bun run db:migrate
  bun run web:build
else
  LATEST_VERSION="$(curl -fsSL "https://api.github.com/repos/elitan/velo/releases/latest" | bun -e "const r = await new Response(Bun.stdin.stream()).json(); console.log(String(r.tag_name || '').replace(/^v/, ''))")"
  if [ -z "$LATEST_VERSION" ]; then
    echo "Could not resolve latest Velo release."
    exit 1
  fi

  curl -fsSL "$VELO_REPO/releases/download/v$LATEST_VERSION/velo-v$LATEST_VERSION.tar.gz" -o /tmp/velo-install.tar.gz
  find "$VELO_DIR" -mindepth 1 -maxdepth 1 ! -name ".velo" -exec rm -rf {} +
  tar -xzf /tmp/velo-install.tar.gz -C "$VELO_DIR"
  rm -f /tmp/velo-install.tar.gz

  cd "$VELO_DIR"
  bun install --production --frozen-lockfile
  VELO_DB="$VELO_DIR/.velo/velo.sqlite" bun run db:migrate
fi

if [ ! -f /etc/velo.env ]; then
  umask 077
  printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -base64 48)" >/etc/velo.env
fi

grep -q '^BETTER_AUTH_URL=' /etc/velo.env || printf 'BETTER_AUTH_URL=%s\n' "$VELO_PUBLIC_URL" >>/etc/velo.env
sed -i '/^VELO_BASIC_AUTH_USERNAME=/d; /^VELO_BASIC_AUTH_PASSWORD=/d' /etc/velo.env

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
ExecStartPre=$VELO_DIR/scripts/update.sh --pre-start
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
