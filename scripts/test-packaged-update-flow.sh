#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
BASE_VERSION="${VELO_TEST_BASE_VERSION:-2.0.0}"
TARGET_VERSION="${VELO_TEST_TARGET_VERSION:-2.0.1}"
PORT="${VELO_TEST_PORT:-$((4300 + RANDOM % 500))}"
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

base_tarball="$WORK_DIR/velo-v$BASE_VERSION.tar.gz"
target_tarball="$WORK_DIR/velo-v$TARGET_VERSION.tar.gz"
release_smoke_create_tarball "$BASE_VERSION" "$base_tarball"
release_smoke_create_tarball "$TARGET_VERSION" "$target_tarball"

release_smoke_extract_tarball "$base_tarball" "$WORK_DIR/app"
test "$(release_smoke_package_version "$WORK_DIR/app/package.json")" = "$BASE_VERSION"

release_smoke_install_production_deps "$WORK_DIR/app"
release_smoke_migrate "$WORK_DIR/app" "$WORK_DIR/app/.velo/velo.sqlite"
release_smoke_seed_table "$WORK_DIR/app/.velo/velo.sqlite" release_packaged_update_smoke

release_smoke_run_update "$WORK_DIR/app" "$WORK_DIR/app/.velo/velo.sqlite" "$TARGET_VERSION" "$target_tarball"

release_smoke_assert_update_result "$WORK_DIR/app" "$TARGET_VERSION"
release_smoke_assert_update_files_private "$WORK_DIR/app"
test "$(release_smoke_package_version "$WORK_DIR/app/package.json")" = "$TARGET_VERSION"
release_smoke_assert_table_value "$WORK_DIR/app/.velo/velo.sqlite" release_packaged_update_smoke

release_smoke_start_app "$WORK_DIR/app" "$WORK_DIR/app/.velo/velo.sqlite" "$PORT" "$WORK_DIR/server.log"
release_smoke_assert_status 200 "$WORK_DIR/server.log" "http://127.0.0.1:$PORT/healthz"

echo "packaged update smoke passed"
