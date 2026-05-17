import { ZFSManager } from '../../managers/zfs';
import { DockerManager } from '../../managers/docker';
import { WALManager } from '../../managers/wal';
import { CertManager } from '../../managers/cert';
import { formatPostgresOwner, resolvePostgresOwner, type PostgresOwner } from '../../managers/postgres-owner';
import { DEFAULTS } from '../../config/defaults';
import { formatTimestamp, generatePassword } from '../../utils/helpers';
import { getZFSPool } from '../../utils/zfs-pool';
import { getContainerName, getDatasetName } from '../../utils/naming';
import { getDb } from '../../db/client';
import { runCommand, runSshCommand } from './command-service';
import { getSetting, setSetting } from './settings-service';
import { setStepStatus } from './setup-state-service';
import { createLocalDockerReplicaBase, isLocalDockerMode } from './local-docker-service';
import { REPLICA_BRANCH_BLOCK_MS } from '#utils/replica-freshness-policy';
const PROJECT_NAME = 'prod';
const BASE_BRANCH_NAME = 'base';
const BASE_DATASET_PREFIX = `${PROJECT_NAME}.${BASE_BRANCH_NAME}-`;
const REPLICATION_USER = 'velo_replica';
const REPLICATION_SLOT = 'velo_replica_base';
const REPLICA_REPLAY_ADVANCE_TIMEOUT_MS = 60_000;
const REPLICA_REPLAY_PAUSE_TIMEOUT_MS = 30_000;
const REPLICA_REPLAY_PAUSE_POLL_MS = 100;
const MAX_SLOT_RETAINED_WAL_BYTES = 1024 * 1024 * 1024;

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

export interface ReplicaBaseHealthInput {
  walReceiverStatus: string | null;
  initialReplayLsn: string | null;
  currentReplayLsn: string | null;
  replayPaused: boolean;
  replayedAt: string | null;
  replayTimelineId: number | null;
  productionTimelineId: number | null;
  slotRetainedWalBytes: number | null;
  now?: Date;
}

export interface ReplicaBaseHealth {
  ok: boolean;
  errors: string[];
  lagMs: number | null;
}

export interface ReplicaReplayPauseOptions {
  docker?: Pick<DockerManager, 'getContainerByName' | 'execSQL'>;
  pollMs?: number;
  timeoutMs?: number;
}

export async function createReplicaBase(): Promise<ReplicaResult> {
  if (isLocalDockerMode()) {
    return createLocalDockerReplicaBase();
  }

  const setupStep = await getDb()
    .selectFrom('setupSteps')
    .select(['status'])
    .where('key', '=', 'replica')
    .executeTakeFirst();
  const shouldRebuildBase = setupStep?.status === 'stale';

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
  const containerName = getContainerName(PROJECT_NAME, BASE_BRANCH_NAME);
  const currentBaseDataset = await getReplicaBaseDataset();
  const currentBaseExists = await zfs.datasetExists(currentBaseDataset);
  const currentBaseHasSlot = currentBaseExists && await productionReplicationSlotExists({
    host: prod.host,
    user: prod.sshUser,
    keyPath: prod.sshKeyPath,
  });
  const shouldCreateNewBase = shouldRebuildBase || !currentBaseExists || !currentBaseHasSlot;
  const baseDataset = shouldCreateNewBase ? buildReplicaBaseDatasetName(new Date()) : currentBaseDataset;
  let createdDataset = false;
  let containerId: string | null = null;

  const existingContainerId = await docker.getContainerByName(containerName);
  if (existingContainerId) {
    await docker.removeContainer(existingContainerId);
  }

  try {
    if (shouldCreateNewBase) {
      await zfs.createDataset(baseDataset, {
        compression: DEFAULTS.zfs.compression,
        recordsize: DEFAULTS.zfs.recordsize,
        atime: DEFAULTS.zfs.atime,
      });
      createdDataset = true;
      await zfs.mountDataset(baseDataset);
      const targetMountpoint = await zfs.getMountpoint(baseDataset);
      await resetProductionReplicationSlot({
        host: prod.host,
        user: prod.sshUser,
        keyPath: prod.sshKeyPath,
      });
      await runBaseBackup({
        prodHost: prod.host,
        replicationPassword,
        targetDir: `${targetMountpoint}/pgdata`,
      });
    } else {
      await zfs.mountDataset(baseDataset);
    }

    const mountpoint = await zfs.getMountpoint(baseDataset);
    const pgdata = `${mountpoint}/pgdata`;
    const pgVersion = await readPgVersion(pgdata);
    const image = `postgres:${pgVersion}-alpine`;

    if (!(await docker.imageExists(image))) {
      await docker.pullImage(image);
    }

    const postgresOwner = await resolvePostgresOwner(image);
    await setPostgresDataOwner(pgdata, postgresOwner);
    await ensurePortablePostgresConfig(pgdata, postgresOwner);

    const certPaths = await cert.generateCerts(PROJECT_NAME, postgresOwner);
    await wal.ensureArchiveDir(baseDataset, postgresOwner);

    containerId = await docker.createContainer({
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
    await assertReplicaBaseHealthy({
      docker,
      containerId,
      prodHost: prod.host,
      prodUser: prod.sshUser,
      prodKeyPath: prod.sshKeyPath,
    });

    await setSetting('replica.baseDataset', baseDataset);
    await setSetting('replica.postgresImage', image);
    await setStepStatus('replica', 'done', `base replica ready on ${baseDataset}`);
    await cleanupOldReplicaBases(baseDataset);
  } catch (error) {
    if (containerId) {
      await docker.removeContainer(containerId).catch(function ignoreContainerCleanupError() {});
    }

    if (createdDataset) {
      await zfs.unmountDataset(baseDataset).catch(function ignoreUnmountCleanupError() {});
      await zfs.destroyDataset(baseDataset, true).catch(function ignoreDatasetCleanupError() {});
      await wal.deleteArchiveDir(baseDataset).catch(function ignoreWalCleanupError() {});
    }

    throw error;
  }

  return {
    ok: true,
    message: `base replica ready on ${baseDataset}`,
  };
}

export async function getReplicaBaseDataset(): Promise<string> {
  const configured = await getSetting('replica.baseDataset');

  if (configured) {
    return configured;
  }

  return getDatasetName(PROJECT_NAME, BASE_BRANCH_NAME);
}

export async function cleanupOldReplicaBases(currentBaseDataset?: string): Promise<void> {
  if (isLocalDockerMode()) {
    return;
  }

  const current = currentBaseDataset ?? await getReplicaBaseDataset();
  const pool = await getZFSPool();
  const zfs = new ZFSManager(pool, DEFAULTS.zfs.datasetBase);
  const wal = new WALManager();
  const prefix = `${pool}/${DEFAULTS.zfs.datasetBase}/`;
  const datasets = await zfs.listDatasets();

  for (const dataset of datasets) {
    const name = dataset.name.startsWith(prefix) ? dataset.name.slice(prefix.length) : dataset.name;

    if (name === current || !isReplicaBaseDataset(name)) {
      continue;
    }

    await zfs.destroyDatasetWithSnapshots(name).catch(function ignoreDependentBase() {});

    if (!(await zfs.datasetExists(name))) {
      await wal.deleteArchiveDir(name).catch(function ignoreWalCleanupError() {});
    }
  }
}

function buildReplicaBaseDatasetName(date: Date): string {
  return `${BASE_DATASET_PREFIX}${formatTimestamp(date).toLowerCase()}`;
}

function isReplicaBaseDataset(name: string): boolean {
  return name === getDatasetName(PROJECT_NAME, BASE_BRANCH_NAME) || name.startsWith(BASE_DATASET_PREFIX);
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

export function buildReplicaBaseHealth(input: ReplicaBaseHealthInput): ReplicaBaseHealth {
  const lagMs = getReplayLagMs(input.replayedAt, input.now ?? new Date());
  const errors: string[] = [];

  if (input.walReceiverStatus !== 'streaming') {
    errors.push('WAL receiver is not streaming');
  }

  if (!input.currentReplayLsn || (input.initialReplayLsn !== null && input.initialReplayLsn === input.currentReplayLsn)) {
    errors.push('replay LSN is not advancing');
  }

  if (input.replayPaused) {
    errors.push('WAL replay is paused');
  }

  if (
    input.productionTimelineId === null
    || input.replayTimelineId === null
    || input.productionTimelineId !== input.replayTimelineId
  ) {
    errors.push('replica timeline does not follow production');
  }

  if (input.slotRetainedWalBytes === null) {
    errors.push(`replication slot ${REPLICATION_SLOT} is missing`);
  } else if (input.slotRetainedWalBytes > MAX_SLOT_RETAINED_WAL_BYTES) {
    errors.push('replication slot retained WAL is too large');
  }

  return {
    ok: errors.length === 0,
    errors,
    lagMs,
  };
}

export async function withPausedReplicaReplay<T>(
  callback: () => Promise<T>,
  options: ReplicaReplayPauseOptions = {}
): Promise<T> {
  const docker = options.docker || new DockerManager();
  const containerName = getContainerName(PROJECT_NAME, BASE_BRANCH_NAME);
  const containerId = await docker.getContainerByName(containerName);

  if (!containerId) {
    throw new Error(`Replica base container not found: ${containerName}`);
  }

  await docker.execSQL(containerId, 'select pg_wal_replay_pause()');

  try {
    await waitForReplayPaused(docker, containerId, options);
    return await callback();
  } finally {
    await docker.execSQL(containerId, 'select pg_wal_replay_resume()');
  }
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

async function assertReplicaBaseHealthy(options: {
  docker: DockerManager;
  containerId: string;
  prodHost: string;
  prodUser: string;
  prodKeyPath: string;
}): Promise<void> {
  const initial = await getDevBaseHealthState(options.docker, options.containerId);
  await switchProductionWal({
    host: options.prodHost,
    user: options.prodUser,
    keyPath: options.prodKeyPath,
  });

  const checked = await waitForReplicaReplayAdvance(options.docker, options.containerId, initial.replayLsn);
  const production = await getProductionHealthState({
    host: options.prodHost,
    user: options.prodUser,
    keyPath: options.prodKeyPath,
  });
  const health = buildReplicaBaseHealth({
    walReceiverStatus: checked.walReceiverStatus,
    initialReplayLsn: initial.replayLsn,
    currentReplayLsn: checked.replayLsn,
    replayPaused: checked.replayPaused,
    replayedAt: checked.replayedAt,
    replayTimelineId: checked.replayTimelineId,
    productionTimelineId: production.timelineId,
    slotRetainedWalBytes: production.slotRetainedWalBytes,
  });

  if (!health.ok) {
    const message = `replica base health check failed: ${health.errors.join(', ')}`;
    await setStepStatus('replica', 'error', message);
    throw new Error(message);
  }
}

async function waitForReplicaReplayAdvance(
  docker: DockerManager,
  containerId: string,
  initialReplayLsn: string | null
): Promise<DevBaseHealthState> {
  const start = Date.now();
  let state = await getDevBaseHealthState(docker, containerId);

  while (Date.now() - start < REPLICA_REPLAY_ADVANCE_TIMEOUT_MS) {
    if (state.replayLsn && state.replayLsn !== initialReplayLsn) {
      return state;
    }

    await Bun.sleep(500);
    state = await getDevBaseHealthState(docker, containerId);
  }

  return state;
}

interface DevBaseHealthState {
  walReceiverStatus: string | null;
  replayLsn: string | null;
  replayedAt: string | null;
  replayPaused: boolean;
  replayTimelineId: number | null;
}

async function getDevBaseHealthState(docker: DockerManager, containerId: string): Promise<DevBaseHealthState> {
  const output = await docker.execSQL(
    containerId,
    [
      'select',
      "coalesce((select status from pg_stat_wal_receiver limit 1), '')",
      "|| '|' || coalesce(pg_last_wal_replay_lsn()::text, '')",
      "|| '|' || coalesce(pg_last_xact_replay_timestamp()::text, '')",
      "|| '|' || pg_is_wal_replay_paused()::text",
      "|| '|' || coalesce((select received_tli::text from pg_stat_wal_receiver limit 1), '')",
    ].join(' ')
  );
  const [walReceiverStatus, replayLsn, replayedAt, replayPaused, replayTimelineId] = output.trim().split('|');

  return {
    walReceiverStatus: walReceiverStatus || null,
    replayLsn: replayLsn || null,
    replayedAt: replayedAt || null,
    replayPaused: replayPaused === 't',
    replayTimelineId: parseNullableInteger(replayTimelineId),
  };
}

async function waitForReplayPaused(
  docker: Pick<DockerManager, 'execSQL'>,
  containerId: string,
  options: Pick<ReplicaReplayPauseOptions, 'pollMs' | 'timeoutMs'>
): Promise<void> {
  const pollMs = options.pollMs ?? REPLICA_REPLAY_PAUSE_POLL_MS;
  const timeoutMs = options.timeoutMs ?? REPLICA_REPLAY_PAUSE_TIMEOUT_MS;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const state = await docker.execSQL(containerId, 'select pg_get_wal_replay_pause_state()');

    if (state.trim() === 'paused') {
      return;
    }

    await Bun.sleep(pollMs);
  }

  throw new Error('Timed out waiting for replica WAL replay to pause');
}

interface ProductionHealthState {
  timelineId: number | null;
  slotRetainedWalBytes: number | null;
}

async function getProductionHealthState(target: {
  host: string;
  user: string;
  keyPath: string;
}): Promise<ProductionHealthState> {
  const query = [
    'select',
    "coalesce((select timeline_id::text from pg_control_checkpoint()), '')",
    "|| '|' || coalesce((",
    'select pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint::text',
    'from pg_replication_slots',
    `where slot_name = '${REPLICATION_SLOT}'`,
    "), '')",
  ].join(' ');
  const output = await runProductionPsql(target, query);
  const [timelineId, slotRetainedWalBytes] = output.trim().split('|');

  return {
    timelineId: parseNullableInteger(timelineId),
    slotRetainedWalBytes: parseNullableInteger(slotRetainedWalBytes),
  };
}

async function switchProductionWal(target: {
  host: string;
  user: string;
  keyPath: string;
}): Promise<void> {
  await runProductionPsql(target, 'select pg_switch_wal()');
}

async function resetProductionReplicationSlot(target: {
  host: string;
  user: string;
  keyPath: string;
}): Promise<void> {
  await runProductionPsql(
    target,
    [
      'select pg_drop_replication_slot(slot_name)',
      'from pg_replication_slots',
      `where slot_name = '${REPLICATION_SLOT}' and not active`,
    ].join(' ')
  );
}

async function productionReplicationSlotExists(target: {
  host: string;
  user: string;
  keyPath: string;
}): Promise<boolean> {
  const output = await runProductionPsql(
    target,
    `select exists(select 1 from pg_replication_slots where slot_name = '${REPLICATION_SLOT}')`
  );

  return output === 't';
}

async function runProductionPsql(target: {
  host: string;
  user: string;
  keyPath: string;
}, query: string): Promise<string> {
  const result = await runSshCommand(
    target,
    `sudo -u postgres psql -tA -c ${shellQuote(query)}`,
    30000
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'production SQL failed');
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
    stale: lagMs === null ? false : lagMs > REPLICA_BRANCH_BLOCK_MS,
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

function parseNullableInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
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
      `PGPASSWORD=${shellQuote(options.replicationPassword)} pg_basebackup -h ${shellQuote(options.prodHost)} -U ${REPLICATION_USER} -D ${shellQuote(options.targetDir)} -R -X stream --checkpoint=fast -C -S ${shellQuote(REPLICATION_SLOT)}`,
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
