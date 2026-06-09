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
source "$ROOT_DIR/scripts/lib/release-smoke.sh"

release_smoke_build_web
TARBALL="$WORK_DIR/velo.tar.gz"
release_smoke_create_tarball "$(release_smoke_package_version "$ROOT_DIR/package.json")" "$TARBALL"

release_smoke_extract_tarball "$TARBALL" "$WORK_DIR/app"

cd "$WORK_DIR/app"
test -f package.json
test -f scripts/update.sh
test -f src/db/migrations/001_initial.sql
test -f dist/server/server.js
test -d dist/client
test -f dist/server/assets/migrations/001_initial.sql

release_smoke_install_production_deps "$WORK_DIR/app"
release_smoke_migrate "$WORK_DIR/app" "$WORK_DIR/app/.velo/velo.sqlite"
release_smoke_migrate "$WORK_DIR/app" "$WORK_DIR/app/.velo/velo.sqlite"
release_smoke_set_password "$WORK_DIR/app" "$WORK_DIR/app/.velo/velo.sqlite" test-password
release_smoke_assert_state_private "$WORK_DIR/app"

release_smoke_start_app "$WORK_DIR/app" "$WORK_DIR/app/.velo/velo.sqlite" "$PORT" "$WORK_DIR/server.log"

release_smoke_assert_status 200 "$WORK_DIR/server.log" "http://127.0.0.1:$PORT/healthz"
release_smoke_assert_status 302 "$WORK_DIR/server.log" -I "http://127.0.0.1:$PORT"
release_smoke_assert_status 200 "$WORK_DIR/server.log" -I "http://127.0.0.1:$PORT/login"
release_smoke_assert_status 401 "$WORK_DIR/server.log" -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$PORT/api/v1/dashboard/retrieve"
release_smoke_assert_status 401 "$WORK_DIR/server.log" -H 'content-type: application/json' -d '{"password":"bad-password"}' "http://127.0.0.1:$PORT/api/auth/login"
curl -fsS -c "$WORK_DIR/cookie" -H 'content-type: application/json' -d '{"password":"test-password"}' "http://127.0.0.1:$PORT/api/auth/login" >/dev/null
release_smoke_assert_status 200 "$WORK_DIR/server.log" -b "$WORK_DIR/cookie" -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$PORT/api/v1/dashboard/retrieve"

echo "release artifact smoke passed"
