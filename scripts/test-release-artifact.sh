#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
PORT="${VELO_TEST_PORT:-$((3900 + RANDOM % 500))}"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

cd "$ROOT_DIR"

bun run web:build
TARBALL="$WORK_DIR/velo.tar.gz"
scripts/create-release-tarball.sh "$(bun -e "import pkg from './package.json'; console.log(pkg.version)")" "$TARBALL" >/dev/null

mkdir -p "$WORK_DIR/app"
tar -xzf "$TARBALL" -C "$WORK_DIR/app"

cd "$WORK_DIR/app"
test -f package.json
test -f scripts/update.sh
test -f src/db/migrations/001_initial.sql
test -f dist/server/server.js
test -d dist/client

bun install --production --frozen-lockfile
VELO_DB="$WORK_DIR/app/.velo/velo.sqlite" bun run db:migrate
VELO_DB="$WORK_DIR/app/.velo/velo.sqlite" bun run db:migrate

HOST=127.0.0.1 \
PORT="$PORT" \
NODE_ENV=production \
VELO_DB="$WORK_DIR/app/.velo/velo.sqlite" \
BETTER_AUTH_SECRET=testtesttesttesttesttesttesttest \
BETTER_AUTH_URL="http://127.0.0.1:$PORT" \
bun src/server/web-runtime.ts >"$WORK_DIR/server.log" 2>&1 &
SERVER_PID="$!"

for _ in $(seq 1 30); do
  if curl -fsS -I "http://127.0.0.1:$PORT" >/dev/null; then
    echo "release artifact smoke passed"
    exit 0
  fi
  sleep 1
done

cat "$WORK_DIR/server.log"
exit 1
