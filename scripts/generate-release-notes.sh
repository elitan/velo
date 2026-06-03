#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?version required}"
OUTPUT="${2:-release_notes.md}"
END_REF="${3:-HEAD}"
REPO="${VELO_RELEASE_REPO:-elitan/velo}"
LAST_TAG="${VELO_LAST_TAG:-$(git describe --tags --abbrev=0 "$END_REF"^ 2>/dev/null || true)}"

if [ -n "$LAST_TAG" ]; then
  RANGE="$LAST_TAG..$END_REF"
else
  RANGE="$END_REF"
fi

tmp="$(mktemp)"
notes="$(mktemp)"
trap 'rm -f "$tmp" "$notes"' EXIT

is_release_mechanics() {
  local subject="$1"
  printf '%s\n' "$subject" | grep -Eq '^chore\(release\): (bump version to|revert .*version bump|revert .*release bump)'
}

git log --pretty=format:'%h%x1f%s' --no-merges "$RANGE" | while IFS=$'\x1f' read -r hash subject || [ -n "$hash$subject" ]; do
  [ -n "$subject" ] || continue
  if is_release_mechanics "$subject"; then
    continue
  fi
  printf '%s\x1f%s\n' "$hash" "$subject"
done > "$tmp"

append_section() {
  local title="$1"
  local pattern="$2"
  local items=""

  while IFS=$'\x1f' read -r hash subject; do
    [ -n "$subject" ] || continue
    if printf '%s\n' "$subject" | grep -Eq "$pattern"; then
      items="${items}- $(format_commit "$hash" "$subject")"$'\n'
    fi
  done < "$tmp"

  if [ -n "$items" ]; then
    {
      printf '### %s\n' "$title"
      printf '%s\n' "$items"
    } >> "$notes"
  fi
}

format_commit() {
  local hash="$1"
  local subject="$2"
  local text

  text="$(printf '%s' "$subject" | sed -E 's/^[a-z]+(\([^)]+\))?!?: //')"
  text="$(printf '%s' "$text" | sed -E "s|#([0-9]+)|[#\1](https://github.com/$REPO/pull/\1)|g")"
  printf '%s ([`%s`](https://github.com/%s/commit/%s))' "$text" "$hash" "$REPO" "$hash"
}

if [ -n "$LAST_TAG" ] && git diff --name-only "$LAST_TAG" "$END_REF" -- src/db/migrations src/db/migrate.ts | grep -q .; then
  {
    printf '> **This release includes Velo SQLite migrations.** Back up `/opt/velo/.velo` before updating.\n\n'
  } >> "$notes"
fi

append_section 'Breaking Changes' '^[a-z]+(\([^)]+\))?!:|BREAKING CHANGE'
append_section 'Features' '^feat(\(|:)'
append_section 'Fixes' '^fix(\(|:)'
append_section 'Refactors' '^refactor(\(|:)'
append_section 'Tests' '^test(\(|:)'
append_section 'Docs' '^docs(\(|:)'
append_section 'Chores' '^chore(\(|:)'

if [ ! -s "$notes" ]; then
  printf '### Changes\n- maintenance release\n\n' >> "$notes"
fi

if [ -n "$LAST_TAG" ]; then
  {
    printf -- '---\n'
    printf '**Full changelog:** [%s...v%s](https://github.com/%s/compare/%s...v%s)\n' "$LAST_TAG" "$VERSION" "$REPO" "$LAST_TAG" "$VERSION"
  } >> "$notes"
fi

cp "$notes" "$OUTPUT"
printf '%s\n' "$OUTPUT"
