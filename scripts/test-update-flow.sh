#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib/release-smoke.sh"

release_smoke_build_web
VERSION="$(release_smoke_package_version "$ROOT_DIR/package.json")"
TARBALL="$WORK_DIR/velo-v$VERSION.tar.gz"
release_smoke_create_tarball "$VERSION" "$TARBALL"

release_smoke_extract_tarball "$TARBALL" "$WORK_DIR/app"

release_smoke_install_production_deps "$WORK_DIR/app"
release_smoke_set_package_version "$WORK_DIR/app" "0.0.0"

release_smoke_migrate "$WORK_DIR/app" "$WORK_DIR/app/.velo/velo.sqlite"
release_smoke_seed_table "$WORK_DIR/app/.velo/velo.sqlite" update_smoke

release_smoke_assert_table_value "$WORK_DIR/app/.velo/velo.sqlite" update_smoke

release_smoke_run_update "$WORK_DIR/app" "$WORK_DIR/app/.velo/velo.sqlite" "$VERSION" "$TARBALL"

release_smoke_assert_update_result "$WORK_DIR/app" "$VERSION"
release_smoke_assert_update_files_private "$WORK_DIR/app"
test "$(release_smoke_package_version "$WORK_DIR/app/package.json")" = "$VERSION"
release_smoke_assert_table_value "$WORK_DIR/app/.velo/velo.sqlite" update_smoke

echo "update flow smoke passed"
