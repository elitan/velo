# Velo AI Install

Give this file to an AI coding agent. The agent should install Velo end-to-end.

## Goal

Install Velo on two Ubuntu/Debian servers:

- `dev/control`: Velo web UI, Docker, ZFS, dev branches.
- `prod`: production Postgres and pgBackRest.

The agent owns the install. The user only gives server access and choices.

## Ask The User

Ask once for missing values:

- dev/control host
- prod host
- SSH user, currently `root`
- SSH private key path or key text
- Velo public URL, usually `http://<dev-host>:3000`
- backup mode: `local` or `s3`
- S3 values if backup mode is `s3`

Generate if missing:

- app password: random 24+ chars
- install dir: `/opt/velo`
- port: `3000`

## Safety

Do not wipe servers unless the user clearly asks.

Stop before touching prod if it already has important data and the user has not confirmed Velo may manage it.

This install may:

- install packages
- create `/opt/velo`
- create `/etc/velo.env`
- create systemd service `velo-web`
- configure Postgres on prod
- restart Postgres
- configure pgBackRest
- create an initial full backup
- create a dev replica base

## Use Repo Code

Use explicit shell commands for server setup. Use Velo TypeScript services only when they keep app state correct:

- web app runtime: `src/server/web-runtime.ts`
- migrations: `src/db/migrate.ts`
- prod/dev setup code: `src/server/services/bootstrap-service.ts`
- replica setup code: `src/server/services/replica-service.ts`
- branch creation code: `src/server/services/branch-service.ts`

## Local Variables

On the machine with SSH access:

```bash
DEV_HOST="<dev-control-host>"
PROD_HOST="<prod-host>"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="<local-private-key-path>"
VELO_REPO="${VELO_REPO:-https://github.com/elitan/velo.git}"
VELO_REF="${VELO_REF:-main}"
VELO_DIR="${VELO_DIR:-/opt/velo}"
VELO_PORT="${VELO_PORT:-3000}"
VELO_PUBLIC_URL="${VELO_PUBLIC_URL:-http://$DEV_HOST:$VELO_PORT}"
REMOTE_KEY_PATH="${REMOTE_KEY_PATH:-/root/.ssh/velo-prod}"
APP_PASSWORD="${APP_PASSWORD:-$(openssl rand -base64 24)}"
BACKUP_MODE="${BACKUP_MODE:-local}"
PROD_ALLOWED_CIDR="${PROD_ALLOWED_CIDR:-$DEV_HOST/32}"
```

For S3 backups, also set:

```bash
BACKUP_ENDPOINT="<s3-endpoint>"
BACKUP_BUCKET="<bucket>"
BACKUP_REGION="${BACKUP_REGION:-auto}"
BACKUP_ACCESS_KEY_ID="<access-key-id>"
BACKUP_SECRET_ACCESS_KEY="<secret-access-key>"
BACKUP_PATH="${BACKUP_PATH:-/prod}"
```

## 1. Check SSH

```bash
ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$SSH_USER@$DEV_HOST" "uname -a && id"
ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$SSH_USER@$PROD_HOST" "uname -a && id"
test "$SSH_USER" = "root"
```

Root is expected right now. If not root, adapt commands carefully with sudo.

## 2. Install Dev/Control Packages

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" "
set -euo pipefail
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  curl git unzip openssl docker.io zfsutils-linux postgresql-client pgbackrest
systemctl enable --now docker
"
```

Install Bun on dev/control:

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" "
set -euo pipefail
export BUN_INSTALL=/root/.bun
export PATH=\$BUN_INSTALL/bin:\$PATH
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi
ln -sf /root/.bun/bin/bun /usr/local/bin/bun
"
```

## 3. Install Prod Packages

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$PROD_HOST" "
set -euo pipefail
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  postgresql postgresql-contrib pgbackrest
systemctl enable --now postgresql
sudo -u postgres pg_isready -d postgres
"
```

## 4. Put Prod SSH Key On Dev

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" "mkdir -p '$(dirname "$REMOTE_KEY_PATH")'"
scp -i "$SSH_KEY" "$SSH_KEY" "$SSH_USER@$DEV_HOST:$REMOTE_KEY_PATH"
ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" "chmod 600 '$REMOTE_KEY_PATH'"
```

## 5. Preflight Installed Tools

Run these before long setup work. Fix failures, then rerun this section.

Check dev/control:

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" "
set -euo pipefail
command -v docker
command -v zfs
command -v psql
command -v pgbackrest
docker info >/dev/null
df -h /
test \"\$(df --output=avail -BG / | tail -1 | tr -dc '0-9')\" -ge 20
zfs version
"
```

Check prod:

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$PROD_HOST" "
set -euo pipefail
command -v psql
command -v pgbackrest
df -h /
test \"\$(df --output=avail -BG / | tail -1 | tr -dc '0-9')\" -ge 20
sudo -u postgres pg_isready -d postgres
"
```

Check dev/control can reach prod over SSH:

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" "
set -euo pipefail
ssh -i '$REMOTE_KEY_PATH' -o BatchMode=yes -o StrictHostKeyChecking=accept-new '$SSH_USER@$PROD_HOST' 'uname -a && id'
"
```

For S3 backups, check required values are present:

```bash
if [ "$BACKUP_MODE" = "s3" ]; then
  test -n "${BACKUP_ENDPOINT:-}"
  test -n "${BACKUP_BUCKET:-}"
  test -n "${BACKUP_ACCESS_KEY_ID:-}"
  test -n "${BACKUP_SECRET_ACCESS_KEY:-}"
fi
```

## 6. Install Velo App

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" "
set -euo pipefail
mkdir -p '$VELO_DIR'
mkdir -p -m 700 '$VELO_DIR/.velo'
chmod 700 '$VELO_DIR/.velo'
if [ ! -d '$VELO_DIR/.git' ]; then
  rm -rf '$VELO_DIR'
  git clone '$VELO_REPO' '$VELO_DIR'
  mkdir -p -m 700 '$VELO_DIR/.velo'
  chmod 700 '$VELO_DIR/.velo'
fi
cd '$VELO_DIR'
git fetch --all --tags
git checkout '$VELO_REF'
git reset --hard '$VELO_REF'
git clean -fd -e node_modules -e .velo
bun install --frozen-lockfile
VELO_DB='$VELO_DIR/.velo/velo.sqlite' bun run db:migrate
APP_PASSWORD='$APP_PASSWORD' VELO_DB='$VELO_DIR/.velo/velo.sqlite' bun run auth:set-password
bun run web:build
"
```

`.velo` contains SQLite state with operational secrets. Keep it private and do not copy or share it.

## 7. Create App Env

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" "
set -euo pipefail
umask 077
touch /etc/velo.env
chmod 600 /etc/velo.env
"
```

## 8. Create Systemd Service

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" "
set -euo pipefail
cat >/etc/systemd/system/velo-web.service <<SERVICE
[Unit]
Description=Velo web UI
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$VELO_DIR
Environment=HOST=0.0.0.0
Environment=PORT=$VELO_PORT
Environment=VELO_DB=$VELO_DIR/.velo/velo.sqlite
Environment=NODE_ENV=production
EnvironmentFile=/etc/velo.env
ExecStartPre=$VELO_DIR/scripts/update.sh --pre-start
ExecStart=/usr/local/bin/bun src/server/web-runtime.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable --now velo-web
"
```

## 9. Save Velo State

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" "
set -euo pipefail
cd '$VELO_DIR'
VELO_DB='$VELO_DIR/.velo/velo.sqlite' \
DEV_HOST='$DEV_HOST' \
PROD_HOST='$PROD_HOST' \
SSH_USER='$SSH_USER' \
SSH_KEY_PATH='$REMOTE_KEY_PATH' \
BACKUP_MODE='$BACKUP_MODE' \
BACKUP_ENDPOINT='${BACKUP_ENDPOINT:-}' \
BACKUP_BUCKET='${BACKUP_BUCKET:-}' \
BACKUP_REGION='${BACKUP_REGION:-auto}' \
BACKUP_ACCESS_KEY_ID='${BACKUP_ACCESS_KEY_ID:-}' \
BACKUP_SECRET_ACCESS_KEY='${BACKUP_SECRET_ACCESS_KEY:-}' \
BACKUP_PATH='${BACKUP_PATH:-/prod}' \
bun - <<'BUN'
import { saveServer, checkServer } from './src/server/services/setup-state-service.ts';
import { saveBackupSettings } from './src/server/services/settings-service.ts';

await saveServer({
  role: 'dev',
  host: process.env.DEV_HOST || '',
  sshUser: process.env.SSH_USER || 'root',
  sshKeyPath: process.env.SSH_KEY_PATH || '',
});

await saveServer({
  role: 'prod',
  host: process.env.PROD_HOST || '',
  sshUser: process.env.SSH_USER || 'root',
  sshKeyPath: process.env.SSH_KEY_PATH || '',
});

await saveBackupSettings({
  enabled: process.env.BACKUP_MODE === 's3',
  endpoint: process.env.BACKUP_ENDPOINT || '',
  bucket: process.env.BACKUP_BUCKET || '',
  region: process.env.BACKUP_REGION || 'auto',
  accessKeyId: process.env.BACKUP_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.BACKUP_SECRET_ACCESS_KEY || '',
  path: process.env.BACKUP_PATH || '/prod',
  pitrDays: 7,
  fullBackupRetentionDays: 90,
});

await checkServer('dev');
await checkServer('prod');
BUN
"
```

## 10. Run Velo Setup Code

Use Velo service code instead of shell scripts. This keeps product behavior and UI state aligned.

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" "
set -euo pipefail
cd '$VELO_DIR'
VELO_DB='$VELO_DIR/.velo/velo.sqlite' bun - <<'BUN'
import { runDevBootstrap, runProdBootstrap } from './src/server/services/bootstrap-service.ts';
import { createReplicaBase } from './src/server/services/replica-service.ts';

function assertOk(result) {
  if (!result.ok) {
    throw new Error(result.message);
  }
}

assertOk(await runDevBootstrap());
assertOk(await runProdBootstrap());
assertOk(await createReplicaBase());
BUN
systemctl restart velo-web
"
```

## 11. Lock Down Prod Network

Velo supports prod over the public internet without a VPN. The safe default is:

- Postgres SSL on
- only `hostssl` entries in `pg_hba.conf`
- prod firewall allows `5432/tcp` only from dev/control
- Velo connects with `sslmode=require`

This encrypts traffic. It does not fully prove server identity yet. For that, Velo should later generate a private CA, install a SAN server cert on prod, copy the CA cert to dev/control, and use `sslmode=verify-full`.

Create a local self-signed Postgres server cert on prod:

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$PROD_HOST" "
set -euo pipefail
PGDATA=\$(sudo -u postgres psql -tAc \"show data_directory\" | xargs)
install -d -o postgres -g postgres -m 700 /etc/postgresql/velo-ssl
openssl req -new -x509 -days 3650 -nodes \
  -subj \"/CN=$PROD_HOST\" \
  -out /etc/postgresql/velo-ssl/server.crt \
  -keyout /etc/postgresql/velo-ssl/server.key
chown postgres:postgres /etc/postgresql/velo-ssl/server.crt /etc/postgresql/velo-ssl/server.key
chmod 600 /etc/postgresql/velo-ssl/server.key
chmod 644 /etc/postgresql/velo-ssl/server.crt
sudo -u postgres psql -c \"alter system set ssl = 'on'\"
sudo -u postgres psql -c \"alter system set ssl_cert_file = '/etc/postgresql/velo-ssl/server.crt'\"
sudo -u postgres psql -c \"alter system set ssl_key_file = '/etc/postgresql/velo-ssl/server.key'\"
HBA_FILE=\$(sudo -u postgres psql -tAc \"show hba_file\" | xargs)
sed -i \"/# velo prod access /d\" \"\$HBA_FILE\"
echo \"hostssl all postgres $PROD_ALLOWED_CIDR scram-sha-256 # velo prod access $PROD_ALLOWED_CIDR\" >>\"\$HBA_FILE\"
systemctl restart postgresql
"
```

Configure firewall on prod. If another firewall is already managed by the host provider, apply the same rule there instead.

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$PROD_HOST" "
set -euo pipefail
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ufw
ufw allow OpenSSH
ufw delete allow 5432/tcp >/dev/null 2>&1 || true
ufw allow from '$DEV_HOST' to any port 5432 proto tcp
ufw --force enable
ufw status verbose
"
```

Verify dev/control can connect to prod with SSL and that non-SSL is rejected:

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" "
set -euo pipefail
cd '$VELO_DIR'
PROD_URL=\$(VELO_DB='$VELO_DIR/.velo/velo.sqlite' bun - <<'BUN'
import { getSetting } from './src/server/services/settings-service.ts';
console.log(await getSetting('prod.connectionUrl'));
BUN
)
psql \"\$PROD_URL\" -c 'select ssl from pg_stat_ssl where pid = pg_backend_pid();'
NON_SSL_URL=\$(printf '%s' \"\$PROD_URL\" | sed 's/sslmode=require/sslmode=disable/')
if psql \"\$NON_SSL_URL\" -c 'select 1'; then
  echo 'expected non-SSL connection to fail' >&2
  exit 1
fi
"
```

## 12. Verify

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" \
  "systemctl is-active --quiet velo-web && curl -fsS -I 'http://127.0.0.1:$VELO_PORT/login' >/dev/null"

ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" \
  "curl -fsS 'http://127.0.0.1:$VELO_PORT/healthz?ready=1' >/dev/null"

ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" \
  "curl -fsS -c /tmp/velo-cookie -H 'content-type: application/json' -d '{\"password\":\"'$APP_PASSWORD'\"}' 'http://127.0.0.1:$VELO_PORT/api/auth/login' >/dev/null && curl -fsS -b /tmp/velo-cookie -H 'content-type: application/json' -d '{}' 'http://127.0.0.1:$VELO_PORT/api/v1/dashboard/retrieve' >/dev/null"

ssh -i "$SSH_KEY" "$SSH_USER@$PROD_HOST" \
  "systemctl is-active --quiet postgresql && sudo -u postgres pg_isready -d postgres && sudo -u postgres pgbackrest --stanza=main info >/dev/null"

ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" "
cd '$VELO_DIR'
VELO_DB='$VELO_DIR/.velo/velo.sqlite' bun - <<'BUN'
import { getDb } from './src/db/client.ts';
import { getSetting } from './src/server/services/settings-service.ts';

const db = getDb();
console.log('servers', await db.selectFrom('servers').select(['role', 'status']).orderBy('role').execute());
console.log('steps', await db.selectFrom('setupSteps').select(['key', 'status']).orderBy('key').execute());
console.log('branches', await db.selectFrom('branches').select(['slug', 'status', 'connectionUrl']).orderBy('slug').execute());
console.log('prod', await getSetting('prod.connectionUrl'));
BUN
"
```

Expected:

- `velo-web` active
- prod Postgres active
- prod Postgres accepts SSL from dev/control
- prod Postgres rejects non-SSL from dev/control
- pgBackRest stanza `main` works
- `/healthz?ready=1` returns ok
- dashboard API returns ok
- setup steps are done
- branch `dev` is running
- UI opens at `VELO_PUBLIC_URL`

## Return To User

Return:

- Velo URL
- app password
- prod connection URL
- dev branch connection URL
- backup mode
- any manual fixes made

## Troubleshooting

Dev logs:

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" "journalctl -u velo-web -n 200 --no-pager"
```

Prod logs:

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$PROD_HOST" "journalctl -u postgresql -n 200 --no-pager"
```

Rebuild app:

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" "cd '$VELO_DIR' && bun install --frozen-lockfile && bun run web:build && systemctl restart velo-web"
```

Rerun setup code:

```bash
ssh -i "$SSH_KEY" "$SSH_USER@$DEV_HOST" "
cd '$VELO_DIR'
VELO_DB='$VELO_DIR/.velo/velo.sqlite' bun - <<'BUN'
import { createJob } from './src/server/services/job-service.ts';
await createJob('setup');
BUN
"
```
