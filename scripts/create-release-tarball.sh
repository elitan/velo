#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-$(bun -e "import pkg from './package.json'; console.log(pkg.version)")}"
OUTPUT="${2:-velo-v$VERSION.tar.gz}"
WORK_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

rsync -a \
  --exclude='.git' \
  --exclude='.github' \
  --exclude='.velo' \
  --exclude='node_modules' \
  --exclude='dist/server/.vite' \
  --exclude='*.tsbuildinfo' \
  ./ "$WORK_DIR/release/"

bun -e "
  import { readFileSync, writeFileSync } from 'node:fs';
  const pkg = JSON.parse(readFileSync('$WORK_DIR/release/package.json', 'utf8'));
  pkg.version = '$VERSION';
  writeFileSync('$WORK_DIR/release/package.json', JSON.stringify(pkg, null, 2) + '\n');
"

tar -czf "$OUTPUT" -C "$WORK_DIR/release" .
tar -tzf "$OUTPUT" >/dev/null

echo "$OUTPUT"
