#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
REPO="${GITHUB_REPOSITORY:-elitan/velo}"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib/release-smoke.sh"

latest_tag="${VELO_RELEASE_TAG:-}"
if [ -z "$latest_tag" ]; then
  latest_tag="$(gh release view --repo "$REPO" --json tagName --jq .tagName 2>/dev/null || true)"
fi

if [ -z "$latest_tag" ]; then
  echo "No GitHub release found, skipping release upgrade smoke"
  exit 0
fi

latest_version="${latest_tag#v}"
IFS='.' read -r major minor patch <<< "$latest_version"
major="${major:-0}"
minor="${minor:-0}"
patch="${patch:-0}"
target_version="${VELO_UPGRADE_TARGET_VERSION:-$major.$minor.$((patch + 1))}"
allow_legacy_fallback=false
if [ "$major" -lt 2 ]; then
  allow_legacy_fallback=true
fi

echo "Testing release upgrade: $latest_tag -> v$target_version"

mkdir -p "$WORK_DIR/release" "$WORK_DIR/current" "$WORK_DIR/app"
release_tarball="$WORK_DIR/release/velo-$latest_tag.tar.gz"
gh release download "$latest_tag" \
  --repo "$REPO" \
  --pattern "velo-$latest_tag.tar.gz" \
  --dir "$WORK_DIR/release" || true

if [ ! -f "$release_tarball" ]; then
  if [ "$allow_legacy_fallback" != true ]; then
    echo "Release $latest_tag is missing velo-$latest_tag.tar.gz."
    exit 1
  fi

  echo "Missing release asset, building $latest_tag from source"
  git clone --depth 1 --branch "$latest_tag" "https://github.com/$REPO.git" "$WORK_DIR/latest-src"
  (
    cd "$WORK_DIR/latest-src"
    if ! jq -e '.scripts["web:build"]' package.json >/dev/null; then
      echo "Latest release source does not have Velo web release scripts, skipping"
      exit 10
    fi
    bun install --frozen-lockfile
    bun run web:build
    scripts/create-release-tarball.sh "$latest_version" "$release_tarball" >/dev/null
  ) || {
    status="$?"
    if [ "$status" = "10" ]; then
      exit 0
    fi
    exit "$status"
  }
fi

release_smoke_build_web
current_tarball="$WORK_DIR/current/velo-v$target_version.tar.gz"
release_smoke_create_tarball "$target_version" "$current_tarball"

release_smoke_extract_tarball "$release_tarball" "$WORK_DIR/app"
release_smoke_install_production_deps "$WORK_DIR/app"

release_smoke_migrate "$WORK_DIR/app" "$WORK_DIR/app/.velo/velo.sqlite"
release_smoke_seed_table "$WORK_DIR/app/.velo/velo.sqlite" release_upgrade_smoke

release_smoke_run_update "$WORK_DIR/app" "$WORK_DIR/app/.velo/velo.sqlite" "$target_version" "$current_tarball"

release_smoke_assert_update_result "$WORK_DIR/app" "$target_version"
release_smoke_assert_update_files_private "$WORK_DIR/app"
test "$(release_smoke_package_version "$WORK_DIR/app/package.json")" = "$target_version"
release_smoke_assert_table_value "$WORK_DIR/app/.velo/velo.sqlite" release_upgrade_smoke

echo "release upgrade smoke passed"
