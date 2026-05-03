#!/usr/bin/env bash
set -Eeuo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required."
  exit 1
fi

VELO_REF="${VELO_REF:-$(gh api repos/elitan/velo/branches/main --jq '.commit.sha')}"
export VELO_REF

echo "Deploying latest main: $VELO_REF"
exec scripts/deploy-hetzner.sh "$@"
