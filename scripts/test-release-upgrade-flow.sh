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

file_mode() {
  if [ "$(uname)" = "Darwin" ]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

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

echo "Testing release upgrade: $latest_tag -> v$target_version"

mkdir -p "$WORK_DIR/release" "$WORK_DIR/current" "$WORK_DIR/app"
release_tarball="$WORK_DIR/release/velo-$latest_tag.tar.gz"
gh release download "$latest_tag" \
  --repo "$REPO" \
  --pattern "velo-$latest_tag.tar.gz" \
  --dir "$WORK_DIR/release" || true

if [ ! -f "$release_tarball" ]; then
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

bun run web:build
current_tarball="$WORK_DIR/current/velo-v$target_version.tar.gz"
scripts/create-release-tarball.sh "$target_version" "$current_tarball" >/dev/null

tar -xzf "$release_tarball" -C "$WORK_DIR/app"
cd "$WORK_DIR/app"
bun install --production --frozen-lockfile

VELO_DB="$WORK_DIR/app/.velo/velo.sqlite" bun run db:migrate
bun -e "
  import { Database } from 'bun:sqlite';
  const db = new Database('$WORK_DIR/app/.velo/velo.sqlite');
  db.exec('create table if not exists release_upgrade_smoke (id integer primary key, value text not null)');
  db.prepare('insert into release_upgrade_smoke (value) values (?)').run('survived');
  db.close();
"

VELO_DIR="$WORK_DIR/app" \
VELO_DB="$WORK_DIR/app/.velo/velo.sqlite" \
VELO_SKIP_ROOT_CHECK=1 \
VELO_SYSTEMCTL= \
VELO_LATEST_VERSION="$target_version" \
VELO_TARBALL_URL="file://$current_tarball" \
bash "$WORK_DIR/app/scripts/update.sh"

test "$(cat "$WORK_DIR/app/.velo/.update-result")" = "success:$target_version"
test "$(file_mode "$WORK_DIR/app/.velo")" = "700"
test "$(file_mode "$WORK_DIR/app/.velo/velo.sqlite")" = "600"
test "$(file_mode "$WORK_DIR/app/.velo/.update-log")" = "600"
test "$(file_mode "$WORK_DIR/app/.velo/.update-result")" = "600"
test "$(bun -e "import pkg from '$WORK_DIR/app/package.json'; console.log(pkg.version)")" = "$target_version"
test "$(bun -e "
  import { Database } from 'bun:sqlite';
  const db = new Database('$WORK_DIR/app/.velo/velo.sqlite');
  const row = db.query('select value from release_upgrade_smoke where id = 1').get();
  console.log(row?.value || '');
  db.close();
")" = "survived"

echo "release upgrade smoke passed"
