import { getDb } from '../../db/client';
import { generatePassword } from '../../utils/helpers';
import { runCommand, runSshCommand } from './command-service';
import { getBackupSettings, getSetting, setSetting } from './settings-service';
import { setStepStatus } from './setup-state-service';

export interface BootstrapResult {
  ok: boolean;
  message: string;
}

export async function runDevBootstrap(): Promise<BootstrapResult> {
  await setStepStatus('dev-check', 'running', 'installing local dev prerequisites');

  const result = await runCommand([
    'sh',
    '-lc',
    [
      'set -e',
      'if command -v apt-get >/dev/null; then',
      '  sudo apt-get update',
      '  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io zfsutils-linux postgresql-client',
      '  sudo systemctl enable --now docker || true',
      'fi',
      'if [ -z "$(sudo zpool list -H -o name 2>/dev/null)" ]; then',
      '  sudo mkdir -p /var/lib/velo',
      '  sudo truncate -s ${VELO_ZFS_FILE_SIZE:-20G} /var/lib/velo/zfs-pool.img',
      '  sudo zpool create tank /var/lib/velo/zfs-pool.img',
      'fi',
      'if ! sudo zfs list tank/velo/databases >/dev/null 2>&1; then',
      '  sudo zfs create -p tank/velo/databases',
      'fi',
      'sudo zfs set compression=lz4 tank/velo/databases',
      'sudo zfs set recordsize=8k tank/velo/databases',
      'sudo zfs set atime=off tank/velo/databases',
      'command -v docker',
      'command -v zfs',
      'command -v pg_basebackup',
    ].join('\n'),
  ], 10 * 60 * 1000);

  const ok = result.exitCode === 0;
  const message = ok ? 'dev prerequisites ready' : result.stderr || result.stdout || 'dev setup failed';

  await setStepStatus('dev-check', ok ? 'done' : 'error', message);
  return { ok, message };
}

export async function runProdBootstrap(): Promise<BootstrapResult> {
  const db = getDb();
  const prod = await db
    .selectFrom('servers')
    .selectAll()
    .where('role', '=', 'prod')
    .executeTakeFirstOrThrow();

  let prodPassword = await getSetting('prod.password');
  if (!prodPassword) {
    prodPassword = generatePassword(28);
    await setSetting('prod.password', prodPassword);
  }

  await setStepStatus('prod-setup', 'running', 'installing Postgres on prod');
  await setStepStatus('backups', 'running', 'configuring pgBackRest');

  const allowedCidr = await getSetting('prod.allowedCidr') || '0.0.0.0/0';
  let pgBackRestConfig: string;
  try {
    pgBackRestConfig = await buildPgBackRestConfig();
  } catch (error: any) {
    const message = error?.message || 'backup settings are incomplete';
    await setStepStatus('backups', 'error', message);
    throw error;
  }

  const result = await runSshCommand(
    {
      host: prod.host,
      user: prod.ssh_user,
      keyPath: prod.ssh_key_path,
    },
    [
      'set -e',
      'if command -v apt-get >/dev/null; then',
      '  sudo apt-get update',
      '  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-contrib pgbackrest',
      'fi',
      'sudo systemctl enable --now postgresql',
      'PGDATA=$(sudo -u postgres psql -tAc "show data_directory" | xargs)',
      'sudo mkdir -p /var/lib/pgbackrest',
      'sudo chown -R postgres:postgres /var/lib/pgbackrest',
      `printf %s ${shellQuote(pgBackRestConfig)} | sudo tee /etc/pgbackrest.conf >/dev/null`,
      'sudo sed -i "s#__PGDATA__#$PGDATA#g" /etc/pgbackrest.conf',
      'sudo chmod 640 /etc/pgbackrest.conf',
      'sudo chown postgres:postgres /etc/pgbackrest.conf',
      `sudo -u postgres psql -c "alter system set archive_mode = 'on'"`,
      `sudo -u postgres psql -c "alter system set archive_command = 'pgbackrest --stanza=main archive-push %p'"`,
      `sudo -u postgres psql -c "alter system set archive_timeout = '60s'"`,
      `sudo -u postgres psql -c "alter system set listen_addresses = '*'"`,
      `sudo -u postgres psql -c "alter system set ssl = 'on'"`,
      `sudo -u postgres psql -c "alter role postgres with password ${sqlStringLiteral(prodPassword)}"`,
      'HBA_FILE=$(sudo -u postgres psql -tAc "show hba_file" | xargs)',
      `grep -q "velo prod access ${allowedCidr}" "$HBA_FILE" || echo "hostssl all postgres ${allowedCidr} scram-sha-256 # velo prod access ${allowedCidr}" | sudo tee -a "$HBA_FILE" >/dev/null`,
      'sudo systemctl restart postgresql',
      'sudo -u postgres pgbackrest --stanza=main stanza-create || sudo -u postgres pgbackrest --stanza=main info',
      'sudo -u postgres pgbackrest --stanza=main check',
      'sudo -u postgres pgbackrest --stanza=main backup --type=full',
      'CRON_FILE=/etc/cron.d/velo-pgbackrest',
      `printf %s ${shellQuote(buildPgBackRestCron())} | sudo tee "$CRON_FILE" >/dev/null`,
      'sudo chmod 644 "$CRON_FILE"',
      "sudo -u postgres psql -tAc 'select version();'",
      'command -v pgbackrest',
    ].join('\n'),
    10 * 60 * 1000
  );

  const ok = result.exitCode === 0;
  const message = ok ? 'prod Postgres ready' : result.stderr || result.stdout || 'prod setup failed';

  await setStepStatus('prod-setup', ok ? 'done' : 'error', message);
  await setStepStatus('backups', ok ? 'done' : 'error', ok ? 'pgBackRest full backup ready' : message);

  if (ok) {
    await setSetting('prod.connectionUrl', formatProdConnectionUrl(prod.host, prodPassword));
  }

  return { ok, message };
}

async function buildPgBackRestConfig(): Promise<string> {
  const backup = await getBackupSettings();
  const secretAccessKey = await getSetting('backup.s3.secretAccessKey') || '';

  if (backup.enabled && (!backup.endpoint || !backup.bucket || !backup.accessKeyId || !secretAccessKey)) {
    throw new Error('S3 backups enabled, but endpoint, bucket, access key, or secret key is missing');
  }

  const repoLines = backup.enabled
    ? [
      'repo1-type=s3',
      `repo1-s3-endpoint=${formatPgBackRestS3Endpoint(backup.endpoint)}`,
      `repo1-s3-bucket=${backup.bucket}`,
      `repo1-s3-region=${backup.region}`,
      `repo1-s3-key=${backup.accessKeyId}`,
      `repo1-s3-key-secret=${secretAccessKey}`,
      'repo1-s3-uri-style=path',
      `repo1-path=${backup.path}`,
    ]
    : [
      'repo1-path=/var/lib/pgbackrest',
    ];

  return [
    '[global]',
    ...repoLines,
    `repo1-retention-full=${backup.fullBackupRetentionDays}`,
    `repo1-retention-archive=${backup.pitrDays}`,
    'repo1-retention-archive-type=full',
    'start-fast=y',
    'log-level-console=info',
    '',
    '[main]',
    'pg1-path=__PGDATA__',
    '',
  ].join('\n');
}

function buildPgBackRestCron(): string {
  return [
    'SHELL=/bin/sh',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '15 2 * * * postgres pgbackrest --stanza=main backup --type=full',
    '',
  ].join('\n');
}

function formatProdConnectionUrl(host: string, password: string): string {
  return `postgresql://postgres:${encodeURIComponent(password)}@${host}:5432/postgres?sslmode=require`;
}

function formatPgBackRestS3Endpoint(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
