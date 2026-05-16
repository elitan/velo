import { ZFSManager } from '../../managers/zfs';
import { DockerManager } from '../../managers/docker';
import { WALManager } from '../../managers/wal';
import { CertManager } from '../../managers/cert';
import { formatPostgresOwner, resolvePostgresOwner, type PostgresOwner } from '../../managers/postgres-owner';
import { DEFAULTS } from '../../config/defaults';
import { generatePassword } from '../../utils/helpers';
import { getZFSPool } from '../../utils/zfs-pool';
import { getContainerName, getDatasetName } from '../../utils/naming';
import { getDb } from '../../db/client';
import { runCommand, runSshCommand } from './command-service';
import { getSetting, setSetting } from './settings-service';
import { setStepStatus } from './setup-state-service';
import { createLocalDockerReplicaBase, isLocalDockerMode } from './local-docker-service';

const PROJECT_NAME = 'prod';
const BASE_BRANCH_NAME = 'base';
const REPLICATION_USER = 'velo_replica';
const STALE_REPLICA_MS = 30_000;

export interface ReplicaResult {
  ok: boolean;
  message: string;
}

export interface ReplicaFreshness {
  prodCurrentLsn: string;
  devReplayLsn: string | null;
  replayedAt: string | null;
  lagMs: number | null;
  byteLag: number | null;
  stale: boolean;
}

export async function createReplicaBase(): Promise<ReplicaResult> {
  if (isLocalDockerMode()) {
    return createLocalDockerReplicaBase();
  }

  await setStepStatus('replica', 'running', 'creating base replica');

  const db = getDb();
  const prod = await db
    .selectFrom('servers')
    .selectAll()
    .where('role', '=', 'prod')
    .executeTakeFirstOrThrow();
  const dev = await db
    .selectFrom('servers')
    .selectAll()
    .where('role', '=', 'dev')
    .executeTakeFirst();

  let replicationPassword = await getSetting('replication.password');
  if (!replicationPassword) {
    replicationPassword = generatePassword(24);
    await setSetting('replication.password', replicationPassword);
  }

  const devCidr = getDevCidr(dev?.host);
  await configureProdReplication({
    host: prod.host,
    user: prod.sshUser,
    keyPath: prod.sshKeyPath,
    password: replicationPassword,
    devCidr,
  });

  const pool = await getZFSPool();
  const zfs = new ZFSManager(pool, DEFAULTS.zfs.datasetBase);
  const docker = new DockerManager();
  const wal = new WALManager();
  const cert = new CertManager();
  const baseDataset = getDatasetName(PROJECT_NAME, BASE_BRANCH_NAME);

  if (!(await zfs.datasetExists(baseDataset))) {
    await zfs.createDataset(baseDataset, {
      compression: DEFAULTS.zfs.compression,
      recordsize: DEFAULTS.zfs.recordsize,
      atime: DEFAULTS.zfs.atime,
    });
    await zfs.mountDataset(baseDataset);
    const mountpoint = await zfs.getMountpoint(baseDataset);
    await runBaseBackup({
      prodHost: prod.host,
      replicationPassword,
      targetDir: `${mountpoint}/pgdata`,
    });
  } else {
    await zfs.mountDataset(baseDataset);
  }

  const mountpoint = await zfs.getMountpoint(baseDataset);
  const pgdata = `${mountpoint}/pgdata`;
  const pgVersion = await readPgVersion(pgdata);
  const image = `postgres:${pgVersion}-alpine`;
  const containerName = getContainerName(PROJECT_NAME, BASE_BRANCH_NAME);

  const existingContainerId = await docker.getContainerByName(containerName);
  if (existingContainerId) {
    await docker.removeContainer(existingContainerId);
  }

  if (!(await docker.imageExists(image))) {
    await docker.pullImage(image);
  }

  const postgresOwner = await resolvePostgresOwner(image);
  await setPostgresDataOwner(pgdata, postgresOwner);
  await ensurePortablePostgresConfig(pgdata, postgresOwner);

  const certPaths = await cert.generateCerts(PROJECT_NAME, postgresOwner);
  await wal.ensureArchiveDir(baseDataset, postgresOwner);

  const containerId = await docker.createContainer({
    name: containerName,
    image,
    port: 0,
    dataPath: mountpoint,
    walArchivePath: wal.getArchivePath(baseDataset),
    sslCertDir: certPaths.certDir,
    password: generatePassword(),
    username: 'postgres',
    database: 'postgres',
    publicAccess: false,
  });

  await docker.startContainer(containerId);
  await docker.waitForHealthy(containerId);

  await setSetting('replica.baseDataset', baseDataset);
  await setSetting('replica.postgresImage', image);
  await setStepStatus('replica', 'done', `base replica ready on ${baseDataset}`);

  return {
    ok: true,
    message: `base replica ready on ${baseDataset}`,
  };
}

export async function getReplicaFreshness(): Promise<ReplicaFreshness | null> {
  const replicaStep = await getDb()
    .selectFrom('setupSteps')
    .select(['status'])
    .where('key', '=', 'replica')
    .executeTakeFirst();

  if (replicaStep?.status !== 'done') {
    return null;
  }

  if (isLocalDockerMode()) {
    return getLocalDockerReplicaFreshness();
  }

  const [prodCurrentLsn, replicaState] = await Promise.all([
    getProductionCurrentLsn(),
    getDevBaseReplayState(),
  ]);

  return buildReplicaFreshness(prodCurrentLsn, replicaState.devReplayLsn, replicaState.replayedAt);
}

async function configureProdReplication(options: {
  host: string;
  user: string;
  keyPath: string;
  password: string;
  devCidr: string;
}): Promise<void> {
  const password = options.password;
  const devCidr = options.devCidr;
  const command = [
    'set -e',
    `sudo -u postgres psql -tAc "select 1 from pg_roles where rolname = '${REPLICATION_USER}'" | grep -q 1 || sudo -u postgres psql -c "create role ${REPLICATION_USER} replication login password '${password}'"`,
    `sudo -u postgres psql -c "alter role ${REPLICATION_USER} with password '${password}'"`,
    `sudo -u postgres psql -c "alter system set listen_addresses = '*'"`,
    `sudo -u postgres psql -c "alter system set wal_level = 'replica'"`,
    `sudo -u postgres psql -c "alter system set max_wal_senders = '10'"`,
    `sudo -u postgres psql -c "alter system set hot_standby = 'on'"`,
    `HBA_FILE=$(sudo -u postgres psql -tAc "show hba_file" | xargs)`,
    `grep -q "velo replication ${devCidr}" "$HBA_FILE" || echo "host replication ${REPLICATION_USER} ${devCidr} scram-sha-256 # velo replication ${devCidr}" | sudo tee -a "$HBA_FILE" >/dev/null`,
    'sudo systemctl restart postgresql',
  ].join('\n');

  const result = await runSshCommand(
    {
      host: options.host,
      user: options.user,
      keyPath: options.keyPath,
    },
    command,
    5 * 60 * 1000
  );

  if (result.exitCode !== 0) {
    await setStepStatus('replica', 'error', result.stderr || result.stdout || 'prod replication setup failed');
    throw new Error(result.stderr || result.stdout || 'prod replication setup failed');
  }
}

async function getProductionCurrentLsn(): Promise<string> {
  const prod = await getDb()
    .selectFrom('servers')
    .selectAll()
    .where('role', '=', 'prod')
    .executeTakeFirstOrThrow();

  const result = await runSshCommand(
    {
      host: prod.host,
      user: prod.sshUser,
      keyPath: prod.sshKeyPath,
    },
    'sudo -u postgres psql -tAc "select pg_current_wal_lsn()"'
  );

  if (result.exitCode !== 0 || !result.stdout) {
    throw new Error(result.stderr || result.stdout || 'could not read production WAL LSN');
  }

  return result.stdout.trim();
}

async function getDevBaseReplayState(): Promise<{ devReplayLsn: string | null; replayedAt: string | null }> {
  const docker = new DockerManager();
  const containerName = getContainerName(PROJECT_NAME, BASE_BRANCH_NAME);
  const containerId = await docker.getContainerByName(containerName);

  if (!containerId) {
    throw new Error(`Replica base container not found: ${containerName}`);
  }

  const output = await docker.execSQL(
    containerId,
    "select pg_last_wal_replay_lsn(), pg_last_xact_replay_timestamp()"
  );

  return parseReplayState(output);
}

async function getLocalDockerReplicaFreshness(): Promise<ReplicaFreshness> {
  const [prodResult, devResult] = await Promise.all([
    runLocalPsql('prod-postgres', 'postgres', 'select pg_current_wal_lsn()'),
    runLocalPsql('dev-postgres', 'postgres', "select pg_current_wal_lsn(), now() - interval '1 millisecond'"),
  ]);
  const replayState = parseReplayState(devResult);

  return buildReplicaFreshness(prodResult.trim(), replayState.devReplayLsn, replayState.replayedAt);
}

async function runLocalPsql(service: string, database: string, query: string): Promise<string> {
  const result = await runCommand([
    'sh',
    '-lc',
    `docker compose -f ${shellQuote(process.env.VELO_LOCAL_COMPOSE_FILE || 'docker-compose.local.yml')} exec -T ${shellQuote(service)} psql -U postgres -d ${shellQuote(database)} -tA -c ${shellQuote(query)}`,
  ]);

  if (result.exitCode !== 0 || !result.stdout) {
    throw new Error(result.stderr || result.stdout || `could not query ${service}`);
  }

  return result.stdout.trim();
}

export function buildReplicaFreshness(
  prodCurrentLsn: string,
  devReplayLsn: string | null,
  replayedAt: string | null,
  now = new Date()
): ReplicaFreshness {
  const lagMs = getReplayLagMs(replayedAt, now);

  return {
    prodCurrentLsn,
    devReplayLsn,
    replayedAt,
    lagMs,
    byteLag: getWalByteLag(prodCurrentLsn, devReplayLsn),
    stale: lagMs === null ? false : lagMs > STALE_REPLICA_MS,
  };
}

function parseReplayState(output: string): { devReplayLsn: string | null; replayedAt: string | null } {
  const [devReplayLsn, replayedAt] = output.trim().split('|');

  return {
    devReplayLsn: devReplayLsn || null,
    replayedAt: replayedAt || null,
  };
}

function getReplayLagMs(replayedAt: string | null, now: Date): number | null {
  if (!replayedAt) {
    return null;
  }

  const replayedTime = new Date(replayedAt).getTime();

  if (Number.isNaN(replayedTime)) {
    return null;
  }

  return Math.max(0, now.getTime() - replayedTime);
}

function getWalByteLag(prodCurrentLsn: string, devReplayLsn: string | null): number | null {
  if (!devReplayLsn) {
    return null;
  }

  const prod = parseWalLsn(prodCurrentLsn);
  const dev = parseWalLsn(devReplayLsn);

  if (prod === null || dev === null) {
    return null;
  }

  return Math.max(0, prod - dev);
}

function parseWalLsn(value: string): number | null {
  const parts = value.split('/');

  if (parts.length !== 2) {
    return null;
  }

  const high = Number.parseInt(parts[0] || '', 16);
  const low = Number.parseInt(parts[1] || '', 16);

  if (!Number.isFinite(high) || !Number.isFinite(low)) {
    return null;
  }

  return high * 0x100000000 + low;
}

async function runBaseBackup(options: {
  prodHost: string;
  replicationPassword: string;
  targetDir: string;
}): Promise<void> {
  const result = await runCommand([
    'sh',
    '-lc',
    [
      `rm -rf ${shellQuote(options.targetDir)}`,
      `mkdir -p ${shellQuote(options.targetDir)}`,
      `PGPASSWORD=${shellQuote(options.replicationPassword)} pg_basebackup -h ${shellQuote(options.prodHost)} -U ${REPLICATION_USER} -D ${shellQuote(options.targetDir)} -R -X stream --checkpoint=fast`,
    ].join('\n'),
  ], 60 * 60 * 1000);

  if (result.exitCode !== 0) {
    await setStepStatus('replica', 'error', result.stderr || result.stdout || 'base backup failed');
    throw new Error(result.stderr || result.stdout || 'base backup failed');
  }
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

async function readPgVersion(pgdata: string): Promise<string> {
  const result = await runCommand(['sh', '-lc', `cat ${shellQuote(pgdata)}/PG_VERSION`]);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'could not read PG_VERSION');
  }

  return result.stdout.trim().split('.')[0] || DEFAULTS.postgres.defaultVersion;
}

function getDevCidr(host: string | undefined): string {
  if (!host || host === 'localhost' || host === '127.0.0.1') {
    return '0.0.0.0/0';
  }

  if (host.includes('/')) {
    return host;
  }

  return `${host}/32`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
