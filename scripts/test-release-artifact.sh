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

file_mode() {
  if [ "$(uname)" = "Darwin" ]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

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
test -f dist/server/assets/migrations/001_initial.sql

bun install --production --frozen-lockfile
VELO_DB="$WORK_DIR/app/.velo/velo.sqlite" bun run db:migrate
VELO_DB="$WORK_DIR/app/.velo/velo.sqlite" bun run db:migrate
APP_PASSWORD=test-password VELO_DB="$WORK_DIR/app/.velo/velo.sqlite" bun run auth:set-password
test "$(file_mode "$WORK_DIR/app/.velo")" = "700"
test "$(file_mode "$WORK_DIR/app/.velo/velo.sqlite")" = "600"

HOST=127.0.0.1 \
PORT="$PORT" \
NODE_ENV=production \
VELO_DB="$WORK_DIR/app/.velo/velo.sqlite" \
bun src/server/web-runtime.ts >"$WORK_DIR/server.log" 2>&1 &
SERVER_PID="$!"

for attempt in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    break
  fi

  if [ "$attempt" = "30" ]; then
    cat "$WORK_DIR/server.log"
    exit 1
  fi

  sleep 1
done

http_status() {
  curl -sS -o /dev/null -w '%{http_code}' "$@"
}

assert_status() {
  expected="$1"
  shift
  actual="$(http_status "$@")"

  if [ "$actual" != "$expected" ]; then
    echo "expected HTTP $expected, got $actual: $*"
    cat "$WORK_DIR/server.log"
    exit 1
  fi
}

assert_status 200 "http://127.0.0.1:$PORT/healthz"
assert_status 302 -I "http://127.0.0.1:$PORT"
assert_status 200 -I "http://127.0.0.1:$PORT/login"
assert_status 401 -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$PORT/api/v1/dashboard/retrieve"
assert_status 401 -H 'content-type: application/json' -d '{"password":"bad-password"}' "http://127.0.0.1:$PORT/api/auth/login"
curl -fsS -c "$WORK_DIR/cookie" -H 'content-type: application/json' -d '{"password":"test-password"}' "http://127.0.0.1:$PORT/api/auth/login" >/dev/null
assert_status 200 -b "$WORK_DIR/cookie" -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$PORT/api/v1/dashboard/retrieve"

echo "release artifact smoke passed"
