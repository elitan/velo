#!/usr/bin/env bash
set -Eeuo pipefail

VELO_DIR="${VELO_DIR:-/opt/velo}"
VELO_REPO="${VELO_REPO:-https://github.com/elitan/velo}"
VELO_SERVICE="${VELO_SERVICE:-velo-web}"
VELO_DB="${VELO_DB:-$VELO_DIR/.velo/velo.sqlite}"
VELO_SKIP_ROOT_CHECK="${VELO_SKIP_ROOT_CHECK:-0}"
VELO_SYSTEMCTL="${VELO_SYSTEMCTL-systemctl}"
VELO_LATEST_VERSION="${VELO_LATEST_VERSION:-}"
VELO_TARBALL_URL="${VELO_TARBALL_URL:-}"
UPDATE_MARKER="$VELO_DIR/.velo/.update-requested"
UPDATE_LOG="$VELO_DIR/.velo/.update-log"
UPDATE_RESULT="$VELO_DIR/.velo/.update-result"
BACKUP_DIR="$VELO_DIR/.backup"
PRE_START=false

umask 077

if [ "${1:-}" = "--pre-start" ]; then
  PRE_START=true
fi

log() {
  echo "$1"
}

service_ctl() {
  if [ -z "$VELO_SYSTEMCTL" ]; then
    return 0
  fi

  "$VELO_SYSTEMCTL" "$1" "$VELO_SERVICE"
}

fail() {
  echo "failed" > "$UPDATE_RESULT"
  chmod 600 "$UPDATE_RESULT" 2>/dev/null || true
  if [ -f "$BACKUP_DIR/commit" ]; then
    log "Restoring previous commit..."
    git reset --hard "$(cat "$BACKUP_DIR/commit")" 2>/dev/null || true
    rm -rf "$BACKUP_DIR"
  elif [ -d "$BACKUP_DIR" ]; then
    log "Restoring previous app files..."
    find "$VELO_DIR" -mindepth 1 -maxdepth 1 ! -name ".velo" ! -name ".backup" -exec rm -rf {} +
    cp -a "$BACKUP_DIR"/. "$VELO_DIR"/
    rm -rf "$BACKUP_DIR"
  fi

  if [ "$PRE_START" = false ]; then
    service_ctl start 2>/dev/null || true
  fi

  exit 1
}

if [ "$PRE_START" = true ] && [ ! -f "$UPDATE_MARKER" ]; then
  exit 0
fi

if [ "$VELO_SKIP_ROOT_CHECK" != "1" ] && [ "$(id -u)" -ne 0 ]; then
  echo "Run as root."
  exit 1
fi

mkdir -p -m 700 "$VELO_DIR/.velo"
chmod 700 "$VELO_DIR/.velo"
find "$VELO_DIR/.velo" -maxdepth 1 -type f \( -name 'velo.sqlite' -o -name 'velo.sqlite-*' -o -name '.update-*' \) -exec chmod 600 {} +
>"$UPDATE_LOG"
chmod 600 "$UPDATE_LOG"
exec > >(tee -a "$UPDATE_LOG") 2>&1
trap fail ERR

export BUN_INSTALL="${BUN_INSTALL:-/root/.bun}"
export PATH="/usr/local/bin:$BUN_INSTALL/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  log "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
fi

if [ -x "$BUN_INSTALL/bin/bun" ] && { [ "$(id -u)" -eq 0 ] || [ -w /usr/local/bin ]; }; then
  ln -sf "$BUN_INSTALL/bin/bun" /usr/local/bin/bun
fi

if [ ! -d "$VELO_DIR" ]; then
  echo "Velo not found at $VELO_DIR."
  exit 1
fi

cd "$VELO_DIR"

REQUESTED_VERSION=""
if [ -f "$UPDATE_MARKER" ]; then
  REQUESTED_VERSION="$(cat "$UPDATE_MARKER" | tr -d '[:space:]')"
  rm -f "$UPDATE_MARKER"
fi

CURRENT_VERSION="$(bun -e "import pkg from './package.json'; console.log(pkg.version)" 2>/dev/null || echo unknown)"
log "Current version: $CURRENT_VERSION"

GIT_MODE=false
if [ -d "$VELO_DIR/.git" ] && git rev-parse HEAD >/dev/null 2>&1; then
  GIT_MODE=true
fi

if [ "$GIT_MODE" = true ]; then
  log "Git mode detected"
  git config --global --add safe.directory "$VELO_DIR" 2>/dev/null || true
  git fetch origin main
  LOCAL="$(git rev-parse HEAD)"
  REMOTE="$(git rev-parse origin/main)"

  if [ "$LOCAL" = "$REMOTE" ] && [ "$PRE_START" = false ]; then
    log "Already up to date."
    service_ctl start 2>/dev/null || true
    exit 0
  fi

  if [ "$PRE_START" = false ]; then
    service_ctl stop 2>/dev/null || true
  fi

  rm -rf "$BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"
  echo "$LOCAL" > "$BACKUP_DIR/commit"

  git reset --hard origin/main
  bun install --frozen-lockfile
  bun run web:build
  VELO_DB="$VELO_DB" bun run db:migrate

  rm -rf "$BACKUP_DIR"
  NEW_VERSION="$(bun -e "import pkg from './package.json'; console.log(pkg.version)")"
  echo "success:$NEW_VERSION" > "$UPDATE_RESULT"
  chmod 600 "$UPDATE_RESULT"

  if [ "$PRE_START" = false ]; then
    service_ctl start
  fi

  log "Updated Velo: $CURRENT_VERSION -> $NEW_VERSION"
  exit 0
fi

LATEST_VERSION="$REQUESTED_VERSION"
if [ -z "$LATEST_VERSION" ] && [ -n "$VELO_LATEST_VERSION" ]; then
  LATEST_VERSION="$VELO_LATEST_VERSION"
fi

if [ -z "$LATEST_VERSION" ] || [ "$LATEST_VERSION" = "latest" ]; then
  LATEST_VERSION="$(curl -fsSL "https://api.github.com/repos/elitan/velo/releases/latest" | bun -e "const r = await new Response(Bun.stdin.stream()).json(); console.log(String(r.tag_name || '').replace(/^v/, ''))")"
fi

if [ -z "$LATEST_VERSION" ]; then
  echo "Could not resolve latest version."
  exit 1
fi

if [ "$CURRENT_VERSION" = "$LATEST_VERSION" ]; then
  log "Already up to date."
  if [ "$PRE_START" = false ]; then
    service_ctl start 2>/dev/null || true
  fi
  exit 0
fi

if [ "$PRE_START" = false ]; then
  service_ctl stop 2>/dev/null || true
fi

rm -rf "$BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
find "$VELO_DIR" -mindepth 1 -maxdepth 1 ! -name ".velo" ! -name ".backup" -exec cp -a {} "$BACKUP_DIR"/ \;

TARBALL_URL="$VELO_TARBALL_URL"
if [ -z "$TARBALL_URL" ]; then
  TARBALL_URL="$VELO_REPO/releases/download/v$LATEST_VERSION/velo-v$LATEST_VERSION.tar.gz"
fi
log "Downloading Velo v$LATEST_VERSION..."
curl -fsSL "$TARBALL_URL" -o /tmp/velo-update.tar.gz

find "$VELO_DIR" -mindepth 1 -maxdepth 1 ! -name ".velo" ! -name ".backup" -exec rm -rf {} +
tar -xzf /tmp/velo-update.tar.gz -C "$VELO_DIR"
rm -f /tmp/velo-update.tar.gz

bun install --production --frozen-lockfile
VELO_DB="$VELO_DB" bun run db:migrate

rm -rf "$BACKUP_DIR"
echo "success:$LATEST_VERSION" > "$UPDATE_RESULT"
chmod 600 "$UPDATE_RESULT"

if [ "$PRE_START" = false ]; then
  service_ctl start
fi

log "Updated Velo: $CURRENT_VERSION -> $LATEST_VERSION"
