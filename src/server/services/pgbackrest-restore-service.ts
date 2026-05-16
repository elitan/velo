import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS } from '../../config/defaults';
import { getDb } from '../../db/client';
import { DockerManager } from '../../managers/docker';
import { WALManager } from '../../managers/wal';
import { ZFSManager } from '../../managers/zfs';
import { CertManager } from '../../managers/cert';
import { formatPostgresOwner, resolvePostgresOwner, type PostgresOwner } from '../../managers/postgres-owner';
import { formatTimestamp, generatePassword } from '../../utils/helpers';
import { getContainerName, getDatasetName } from '../../utils/naming';
import { getZFSPool } from '../../utils/zfs-pool';
import { getBackupAvailability } from './backup-availability-service';
import { buildPgBackRestConfig } from './bootstrap-service';
import { runCommand, runSshCommand } from './command-service';
import { getBackupSettings, setSetting } from './settings-service';
import { createLocalDockerPitrBranch, isLocalDockerMode, restoreLocalDockerProduction } from './local-docker-service';

const PROJECT_NAME = 'prod';

export interface RestoreBranchInput {
  targetBranch: string;
  sourceBranch: string;
  restoreTime: string;
  readOnly?: boolean;
  publicAccess?: boolean;
  branchPassword?: string | null;
  preferredPort?: number | null;
}

export interface RestoreBranchResult {
  id: number;
  slug: string;
  displayName: string;
  connectionUrl: string;
}

export async function createBranchFromPgBackRest(input: RestoreBranchInput): Promise<RestoreBranchResult> {
  if (isLocalDockerMode()) {
    const restoreTime = parseRestoreTime(input.restoreTime);
    await assertWithinPitrWindow(restoreTime);

    return createLocalDockerPitrBranch({
      targetBranch: input.targetBranch,
      restoreTime: restoreTime.toISOString(),
      readOnly: input.readOnly,
      publicAccess: input.publicAccess,
      branchPassword: input.branchPassword,
      preferredPort: input.preferredPort,
    });
  }

  assertProdSource(input.sourceBranch);

  const branchName = normalizeBranchName(input.targetBranch);
  const restoreTime = parseRestoreTime(input.restoreTime);
  await assertWithinPitrWindow(restoreTime);
  const db = getDb();
  const project = await ensureProject();
  const devServer = await db
    .selectFrom('servers')
    .select(['host'])
    .where('role', '=', 'dev')
    .executeTakeFirst();
  const backup = await getBackupSettings();
  const branchPassword = input.branchPassword || generatePassword();

  const pool = await getZFSPool();
  const zfs = new ZFSManager(pool, DEFAULTS.zfs.datasetBase);
  const docker = new DockerManager();
  const wal = new WALManager();
  const cert = new CertManager();

  const dataset = getDatasetName(PROJECT_NAME, branchName);
  const containerName = getContainerName(PROJECT_NAME, branchName);

  if (await zfs.datasetExists(dataset)) {
    throw new Error(`Branch dataset already exists: ${dataset}`);
  }

  let containerId: string | null = null;

  try {
    await zfs.createDataset(dataset, {
      compression: DEFAULTS.zfs.compression,
      recordsize: DEFAULTS.zfs.recordsize,
      atime: DEFAULTS.zfs.atime,
    });
    await zfs.mountDataset(dataset);

    const mountpoint = await zfs.getMountpoint(dataset);
    const pgdata = `${mountpoint}/pgdata`;
    await restorePgBackRestLocally(pgdata, restoreTime);

    const pgVersion = await readPgVersion(pgdata);
    const image = await ensurePgBackRestPostgresImage(pgVersion);

    if (!(await docker.imageExists(image))) {
      await docker.pullImage(image);
    }

    const postgresOwner = await resolvePostgresOwner(image);
    await setPostgresDataOwner(pgdata, postgresOwner);
    await writeContainerPgBackRestConfig(mountpoint, pgdata, postgresOwner);
    await ensurePortablePostgresConfig(pgdata, postgresOwner);

    const certPaths = await cert.generateCerts(PROJECT_NAME, postgresOwner);
    await wal.ensureArchiveDir(dataset, postgresOwner);

    containerId = await docker.createContainer({
      name: containerName,
      image,
      port: input.preferredPort || 0,
      dataPath: mountpoint,
      walArchivePath: wal.getArchivePath(dataset),
      sslCertDir: certPaths.certDir,
      password: branchPassword,
      username: 'postgres',
      database: 'postgres',
      publicAccess: input.publicAccess === true,
      readOnly: input.readOnly === true,
      restoreCommand: null,
      pgBackRestRepoPath: backup.enabled ? null : '/var/lib/pgbackrest',
    });

    await docker.startContainer(containerId);
    await docker.waitForHealthy(containerId, 10 * 60 * 1000);
    await waitForPromotion(docker, containerId, 10 * 60 * 1000);
    await setBranchPassword(docker, containerId, branchPassword);

    const port = await docker.getContainerPort(containerId);
    const connectionUrl = formatPostgresConnectionUrl(
      'postgres',
      branchPassword,
      devServer?.host || 'localhost',
      port,
      'postgres'
    );

    await db
      .insertInto('branches')
      .values({
        projectId: project.id,
        slug: branchName,
        displayName: branchName,
        dataset,
        port,
        status: 'running',
        parentBranchId: null,
        sourceReplayAt: restoreTime.toISOString(),
        connectionUrl: connectionUrl,
      })
      .execute();

    const row = await db
      .selectFrom('branches')
      .select(['id', 'slug', 'displayName', 'connectionUrl'])
      .where('projectId', '=', project.id)
      .where('slug', '=', branchName)
      .executeTakeFirstOrThrow();

    return {
      id: row.id,
      slug: row.slug,
      displayName: row.displayName,
      connectionUrl: row.connectionUrl || connectionUrl,
    };
  } catch (error) {
    if (containerId) {
      await docker.removeContainer(containerId).catch(function ignoreContainerCleanupError() {});
    }

    await zfs.unmountDataset(dataset).catch(function ignoreUnmountCleanupError() {});

    if (await zfs.datasetExists(dataset)) {
      await zfs.destroyDataset(dataset, true).catch(function ignoreDatasetCleanupError() {});
    }

    await wal.deleteArchiveDir(dataset).catch(function ignoreWalCleanupError() {});
    throw error;
  }
}

export async function restoreDevelopmentBranchFromPgBackRest(input: RestoreBranchInput): Promise<RestoreBranchResult> {
  const targetBranch = normalizeBranchName(input.targetBranch);

  if (isProductionBranch(targetBranch)) {
    throw new Error('Use restoreProductionFromPgBackRest for production restores');
  }

  return createBranchFromPgBackRest({
    ...input,
    targetBranch,
    readOnly: false,
    publicAccess: true,
  });
}

export async function restoreProductionFromPgBackRest(input: RestoreBranchInput): Promise<void> {
  if (isLocalDockerMode()) {
    const restoreTime = parseRestoreTime(input.restoreTime);
    await assertWithinPitrWindow(restoreTime);
    await restoreLocalDockerProduction({
      targetBranch: 'production',
      restoreTime: restoreTime.toISOString(),
    });
    return;
  }

  assertProdSource(input.sourceBranch);
  const restoreTime = parseRestoreTime(input.restoreTime);
  await assertWithinPitrWindow(restoreTime);
  const db = getDb();
  const prod = await db
    .selectFrom('servers')
    .selectAll()
    .where('role', '=', 'prod')
    .executeTakeFirstOrThrow();

  const command = [
    'set -e',
    `TARGET=${shellQuote(formatPgBackRestTime(restoreTime))}`,
    'PGDATA=$(sudo -u postgres psql -tAc "show data_directory" | xargs)',
    'BACKUP="${PGDATA}.velo-before-pitr-$(date +%Y%m%d%H%M%S)"',
    'sudo systemctl stop postgresql',
    'sudo mv "$PGDATA" "$BACKUP"',
    'sudo install -d -o postgres -g postgres -m 700 "$PGDATA"',
    'if ! sudo -u postgres pgbackrest --stanza=main --type=time --target="$TARGET" --target-action=promote restore; then',
    '  sudo rm -rf "$PGDATA"',
    '  sudo mv "$BACKUP" "$PGDATA"',
    '  sudo systemctl start postgresql',
    '  exit 1',
    'fi',
    'sudo systemctl start postgresql',
    'sudo -u postgres psql -tAc "select pg_is_in_recovery();"',
  ].join('\n');

  const result = await runSshCommand(
    {
      host: prod.host,
      user: prod.sshUser,
      keyPath: prod.sshKeyPath,
    },
    command,
    60 * 60 * 1000
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'production PITR restore failed');
  }

  await setSetting('prod.lastRestoreAt', restoreTime.toISOString());
}

async function restorePgBackRestLocally(pgdata: string, restoreTime: Date): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'velo-pgbackrest-'));
  const configPath = join(tempDir, 'pgbackrest.conf');

  try {
    const config = await buildPgBackRestConfig();
    await writeFile(configPath, config.replace('__PGDATA__', pgdata), { mode: 0o600 });

    const result = await runCommand([
      'sh',
      '-lc',
      [
        `rm -rf ${shellQuote(pgdata)}`,
        `mkdir -p ${shellQuote(pgdata)}`,
        `pgbackrest --config=${shellQuote(configPath)} --stanza=main --pg1-path=${shellQuote(pgdata)} --type=time --target=${shellQuote(formatPgBackRestTime(restoreTime))} --target-action=promote restore`,
      ].join('\n'),
    ], 60 * 60 * 1000);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || 'pgBackRest restore failed');
    }
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(function ignoreCleanupError() {});
  }

}

async function writeContainerPgBackRestConfig(
  mountpoint: string,
  pgdata: string,
  postgresOwner: PostgresOwner
): Promise<void> {
  const hostConfig = await buildPgBackRestConfig();
  const containerConfigPath = `${mountpoint}/pgbackrest.conf`;
  const containerPgdata = '/var/lib/postgresql/data/pgdata';
  const containerConfig = hostConfig.replace('__PGDATA__', containerPgdata);
  const restoreCommand = `restore_command = 'pgbackrest --config=/var/lib/postgresql/data/pgbackrest.conf --pg1-path=${containerPgdata} --stanza=main archive-get %f "%p"'`;
  const autoConfPath = `${pgdata}/postgresql.auto.conf`;

  await writeFile(containerConfigPath, containerConfig, { mode: 0o600 });

  const result = await runCommand([
    'sh',
    '-lc',
    [
      `if grep -q '^restore_command =' ${shellQuote(autoConfPath)}; then`,
      `  sed -i ${shellQuote(`s#^restore_command =.*#${restoreCommand}#`)} ${shellQuote(autoConfPath)}`,
      'else',
      `  printf '\\n%s\\n' ${shellQuote(restoreCommand)} >> ${shellQuote(autoConfPath)}`,
      'fi',
      `sudo chown ${formatPostgresOwner(postgresOwner)} ${shellQuote(containerConfigPath)} ${shellQuote(autoConfPath)}`,
      `sudo chmod 600 ${shellQuote(containerConfigPath)} ${shellQuote(autoConfPath)}`,
    ].join('\n'),
  ]);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'failed to write pgBackRest runtime config');
  }
}

async function ensurePgBackRestPostgresImage(pgVersion: string): Promise<string> {
  const tag = `velo-postgres-pgbackrest:${pgVersion}`;
  const docker = new DockerManager();

  if (await docker.imageExists(tag)) {
    return tag;
  }

  const dockerfile = [
    `FROM postgres:${pgVersion}-alpine`,
    'RUN apk add --no-cache pgbackrest',
    '',
  ].join('\n');

  const result = await runCommand([
    'sh',
    '-lc',
    `printf %s ${shellQuote(dockerfile)} | docker build -t ${shellQuote(tag)} -`,
  ], 20 * 60 * 1000);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `failed to build ${tag}`);
  }

  return tag;
}

async function ensurePortablePostgresConfig(pgdata: string, postgresOwner: PostgresOwner): Promise<void> {
  const result = await runCommand([
    'sh',
    '-lc',
    [
      `cat > ${shellQuote(`${pgdata}/postgresql.conf`)} <<'CONF'`,
      "listen_addresses = '*'",
      "hot_standby = on",
      "include_if_exists = 'postgresql.auto.conf'",
      'CONF',
      `cat > ${shellQuote(`${pgdata}/pg_hba.conf`)} <<'HBA'`,
      'local all all trust',
      'hostssl all all 0.0.0.0/0 scram-sha-256',
      'hostssl all all ::/0 scram-sha-256',
      'host replication all 0.0.0.0/0 scram-sha-256',
      'host replication all ::/0 scram-sha-256',
      'HBA',
      `touch ${shellQuote(`${pgdata}/pg_ident.conf`)}`,
      `sudo chown ${formatPostgresOwner(postgresOwner)} ${shellQuote(`${pgdata}/postgresql.conf`)} ${shellQuote(`${pgdata}/pg_hba.conf`)} ${shellQuote(`${pgdata}/pg_ident.conf`)}`,
      `sudo chmod 600 ${shellQuote(`${pgdata}/postgresql.conf`)} ${shellQuote(`${pgdata}/pg_hba.conf`)} ${shellQuote(`${pgdata}/pg_ident.conf`)}`,
    ].join('\n'),
  ]);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'failed to write portable Postgres config');
  }
}

async function setPostgresDataOwner(pgdata: string, postgresOwner: PostgresOwner): Promise<void> {
  const result = await runCommand([
    'sh',
    '-lc',
    `sudo chown -R ${formatPostgresOwner(postgresOwner)} ${shellQuote(pgdata)}`,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'failed to set Postgres data ownership');
  }
}

async function setBranchPassword(docker: DockerManager, containerId: string, password: string): Promise<void> {
  await docker.execSQL(containerId, `alter role postgres with password ${sqlStringLiteral(password)}`);
}

async function waitForPromotion(docker: DockerManager, containerId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const result = await docker.execSQL(containerId, 'select pg_is_in_recovery()');

      if (result.trim() === 'f') {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await Bun.sleep(500);
  }

  throw new Error(`restored Postgres did not promote before timeout: ${String(lastError || 'still in recovery')}`);
}

async function readPgVersion(pgdata: string): Promise<string> {
  const result = await runCommand(['sh', '-lc', `cat ${shellQuote(pgdata)}/PG_VERSION`]);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'could not read PG_VERSION');
  }

  return result.stdout.trim().split('.')[0] || DEFAULTS.postgres.defaultVersion;
}

async function ensureProject() {
  const db = getDb();
  const existing = await db
    .selectFrom('projects')
    .selectAll()
    .where('name', '=', PROJECT_NAME)
    .executeTakeFirst();

  if (existing) {
    return existing;
  }

  await db
    .insertInto('projects')
    .values({
      name: PROJECT_NAME,
      postgresVersion: DEFAULTS.postgres.defaultVersion,
      databaseName: 'postgres',
      appUser: 'postgres',
    })
    .execute();

  return db
    .selectFrom('projects')
    .selectAll()
    .where('name', '=', PROJECT_NAME)
    .executeTakeFirstOrThrow();
}

function assertProdSource(sourceBranch: string): void {
  if (!isProductionBranch(sourceBranch)) {
    throw new Error('PITR restore currently supports production as the source branch');
  }
}

function isProductionBranch(branch: string): boolean {
  const normalized = branch.trim().toLowerCase();
  return normalized === 'production' || normalized === 'prod';
}

function normalizeBranchName(name: string): string {
  const normalized = name.trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(normalized)) {
    throw new Error('Branch name must use lowercase letters, numbers, hyphens, or underscores');
  }

  return normalized;
}

function parseRestoreTime(value: string): Date {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error('Restore time is invalid');
  }

  return date;
}

async function assertWithinPitrWindow(restoreTime: Date): Promise<void> {
  const availability = await getBackupAvailability();
  const now = Date.now();
  const restoreTimestamp = restoreTime.getTime();

  if (availability.status !== 'ok' || !availability.pitr.from || !availability.pitr.to) {
    throw new Error(availability.message || 'Backup availability is unavailable');
  }

  const actualMinTime = new Date(availability.pitr.from).getTime();
  const actualMaxTime = new Date(availability.pitr.to).getTime();

  if (restoreTimestamp > now) {
    throw new Error('Restore time cannot be in the future');
  }

  if (restoreTimestamp < actualMinTime || restoreTimestamp > actualMaxTime) {
    throw new Error(`Restore time must be between ${availability.pitr.from} and ${availability.pitr.to}`);
  }
}

function formatPgBackRestTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '+00');
}

function formatPostgresConnectionUrl(
  username: string,
  password: string,
  host: string,
  port: number,
  database: string
): string {
  return `postgresql://${username}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=require`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
