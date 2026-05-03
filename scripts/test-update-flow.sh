#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

cd "$ROOT_DIR"

bun run web:build
VERSION="$(bun -e "import pkg from './package.json'; console.log(pkg.version)")"
TARBALL="$WORK_DIR/velo-v$VERSION.tar.gz"
scripts/create-release-tarball.sh "$VERSION" "$TARBALL" >/dev/null

mkdir -p "$WORK_DIR/app/.velo"
tar -xzf "$TARBALL" -C "$WORK_DIR/app"

cd "$WORK_DIR/app"
bun install --production --frozen-lockfile

bun -e "
  import { readFileSync, writeFileSync } from 'node:fs';
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  pkg.version = '0.0.0';
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

VELO_DB="$WORK_DIR/app/.velo/velo.sqlite" bun run db:migrate
bun -e "
  import { Database } from 'bun:sqlite';
  const db = new Database('$WORK_DIR/app/.velo/velo.sqlite');
  db.exec('create table if not exists update_smoke (id integer primary key, value text not null)');
  db.prepare('insert into update_smoke (value) values (?)').run('survived');
  db.close();
"

test "$(bun -e "
  import { Database } from 'bun:sqlite';
  const db = new Database('$WORK_DIR/app/.velo/velo.sqlite');
  const row = db.query('select value from update_smoke where id = 1').get();
  console.log(row?.value || '');
  db.close();
")" = "survived"

VELO_DIR="$WORK_DIR/app" \
VELO_DB="$WORK_DIR/app/.velo/velo.sqlite" \
VELO_SKIP_ROOT_CHECK=1 \
VELO_SYSTEMCTL= \
VELO_LATEST_VERSION="$VERSION" \
VELO_TARBALL_URL="file://$TARBALL" \
bash "$WORK_DIR/app/scripts/update.sh"

test "$(cat "$WORK_DIR/app/.velo/.update-result")" = "success:$VERSION"
test "$(bun -e "import pkg from '$WORK_DIR/app/package.json'; console.log(pkg.version)")" = "$VERSION"
test "$(bun -e "
  import { Database } from 'bun:sqlite';
  const db = new Database('$WORK_DIR/app/.velo/velo.sqlite');
  const row = db.query('select value from update_smoke where id = 1').get();
  console.log(row?.value || '');
  db.close();
")" = "survived"

echo "update flow smoke passed"
