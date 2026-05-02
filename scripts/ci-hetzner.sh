#!/usr/bin/env bash
set -Eeuo pipefail

HETZNER_API_TOKEN="${HETZNER_API_TOKEN:-${HETZNER_API_KEY:-}}"
VELO_DEPLOY_KEY="${VELO_DEPLOY_KEY:?Set VELO_DEPLOY_KEY}"
VELO_REPO="${VELO_REPO:-https://github.com/elitan/velo.git}"
VELO_REF="${VELO_REF:-$(git rev-parse HEAD)}"
VELO_CI_RUN_ID="${VELO_CI_RUN_ID:-local-$(date +%s)}"
VELO_CI_SERVER_TYPE="${VELO_CI_SERVER_TYPE:-cx23}"
VELO_CI_IMAGE="${VELO_CI_IMAGE:-ubuntu-24.04}"
VELO_CI_LOCATION="${VELO_CI_LOCATION:-hel1}"

if [ -z "$HETZNER_API_TOKEN" ]; then
  echo "Set HETZNER_API_TOKEN"
  exit 1
fi

SSH_KEY_ID=""
APP_SERVER_ID=""
PROD_SERVER_ID=""
APP_SERVER_IP=""
PROD_SERVER_IP=""

hcloud() {
  local method="$1"
  local path="$2"
  local data="${3:-}"

  if [ -n "$data" ]; then
    curl -fsS -X "$method" \
      -H "Authorization: Bearer $HETZNER_API_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$data" \
      "https://api.hetzner.cloud/v1$path"
    return
  fi

  curl -fsS -X "$method" \
    -H "Authorization: Bearer $HETZNER_API_TOKEN" \
    "https://api.hetzner.cloud/v1$path"
}

cleanup() {
  if [ -n "$APP_SERVER_ID" ]; then
    echo "Deleting app server $APP_SERVER_ID"
    hcloud DELETE "/servers/$APP_SERVER_ID" >/dev/null || true
  fi

  if [ -n "$PROD_SERVER_ID" ]; then
    echo "Deleting database server $PROD_SERVER_ID"
    hcloud DELETE "/servers/$PROD_SERVER_ID" >/dev/null || true
  fi

  if [ -n "$SSH_KEY_ID" ]; then
    echo "Deleting SSH key $SSH_KEY_ID"
    hcloud DELETE "/ssh_keys/$SSH_KEY_ID" >/dev/null || true
  fi
}

trap cleanup EXIT

create_ssh_key() {
  local public_key
  local payload
  local response

  public_key="$(ssh-keygen -y -f "$VELO_DEPLOY_KEY")"
  payload="$(jq -n \
    --arg name "velo-ci-$VELO_CI_RUN_ID" \
    --arg public_key "$public_key" \
    --arg run_id "$VELO_CI_RUN_ID" \
    '{name:$name, public_key:$public_key, labels:{purpose:"velo-ci", run_id:$run_id}}')"
  response="$(hcloud POST /ssh_keys "$payload")"
  SSH_KEY_ID="$(echo "$response" | jq -r '.ssh_key.id')"

  if [ -z "$SSH_KEY_ID" ] || [ "$SSH_KEY_ID" = "null" ]; then
    echo "$response" | jq .
    exit 1
  fi
}

create_server() {
  local role="$1"
  local name="velo-ci-$VELO_CI_RUN_ID-$role"
  local payload
  local response
  local server_id
  local server_ip

  payload="$(jq -n \
    --arg name "$name" \
    --arg server_type "$VELO_CI_SERVER_TYPE" \
    --arg image "$VELO_CI_IMAGE" \
    --arg location "$VELO_CI_LOCATION" \
    --arg role "$role" \
    --arg run_id "$VELO_CI_RUN_ID" \
    --argjson ssh_key_id "$SSH_KEY_ID" \
    '{name:$name, server_type:$server_type, image:$image, location:$location, ssh_keys:[$ssh_key_id], start_after_create:true, labels:{purpose:"velo-ci", role:$role, run_id:$run_id}}')"

  response="$(hcloud POST /servers "$payload")"
  server_id="$(echo "$response" | jq -r '.server.id')"
  server_ip="$(echo "$response" | jq -r '.server.public_net.ipv4.ip')"

  if [ -z "$server_id" ] || [ "$server_id" = "null" ] || [ -z "$server_ip" ] || [ "$server_ip" = "null" ]; then
    echo "$response" | jq .
    exit 1
  fi

  if [ "$role" = "app" ]; then
    APP_SERVER_ID="$server_id"
    APP_SERVER_IP="$server_ip"
  else
    PROD_SERVER_ID="$server_id"
    PROD_SERVER_IP="$server_ip"
  fi

  echo "$role server: $server_ip ($server_id)"
}

wait_for_server() {
  local server_id="$1"
  local status

  for _ in $(seq 1 60); do
    status="$(hcloud GET "/servers/$server_id" | jq -r '.server.status')"
    if [ "$status" = "running" ]; then
      return
    fi
    sleep 5
  done

  echo "server $server_id did not become running"
  exit 1
}

wait_for_ssh() {
  local host="$1"

  for _ in $(seq 1 60); do
    if ssh -i "$VELO_DEPLOY_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "root@$host" "echo ready" >/dev/null 2>&1; then
      return
    fi
    sleep 5
  done

  echo "ssh did not become ready for $host"
  exit 1
}

main() {
  create_ssh_key
  create_server app
  create_server prod
  wait_for_server "$APP_SERVER_ID"
  wait_for_server "$PROD_SERVER_ID"
  wait_for_ssh "$APP_SERVER_IP"
  wait_for_ssh "$PROD_SERVER_IP"

  VELO_DEPLOY_DEV_HOST="$APP_SERVER_IP" \
    VELO_DEPLOY_PROD_HOST="$PROD_SERVER_IP" \
    VELO_DEPLOY_USER=root \
    VELO_DEPLOY_KEY="$VELO_DEPLOY_KEY" \
    VELO_REPO="$VELO_REPO" \
    VELO_REF="$VELO_REF" \
    scripts/e2e-hetzner.sh
}

main "$@"
