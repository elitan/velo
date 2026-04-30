import { ZFSManager } from '../../managers/zfs';
import { DockerManager } from '../../managers/docker';
import { WALManager } from '../../managers/wal';
import { CertManager } from '../../managers/cert';
import { DEFAULTS } from '../../config/defaults';
import { formatTimestamp, generatePassword } from '../../utils/helpers';
import { getZFSPool } from '../../utils/zfs-pool';
import { getContainerName, getDatasetName } from '../../utils/naming';
import { getDb } from '../../db/client';
import { runCommand } from './command-service';
import { getSetting } from './settings-service';
import { setStepStatus } from './setup-state-service';

const PROJECT_NAME = 'prod';
const BASE_BRANCH_NAME = 'base';

export interface CreateBranchInput {
  name: string;
}

export interface CreateBranchResult {
  id: number;
  name: string;
  connectionUrl: string;
}

export interface DeleteBranchInput {
  id: number;
}

export interface DeleteBranchResult {
  id: number;
  name: string;
}

export async function createBranchFromBase(input: CreateBranchInput): Promise<CreateBranchResult> {
  const branchName = normalizeBranchName(input.name);
  await setStepStatus('first-branch', 'running', `creating ${branchName}`);

  const db = getDb();
  const project = await ensureProject();
  const devServer = await db
    .selectFrom('servers')
    .select(['host'])
    .where('role', '=', 'dev')
    .executeTakeFirst();
  const pool = await getZFSPool();
  const zfs = new ZFSManager(pool, DEFAULTS.zfs.datasetBase);
  const docker = new DockerManager();
  const wal = new WALManager();
  const cert = new CertManager();

  const baseDataset = getDatasetName(PROJECT_NAME, BASE_BRANCH_NAME);
  const targetDataset = getDatasetName(PROJECT_NAME, branchName);
  const targetContainer = getContainerName(PROJECT_NAME, branchName);

  if (!(await zfs.datasetExists(baseDataset))) {
    await setStepStatus('replica', 'error', `missing ZFS base dataset ${baseDataset}`);
    throw new Error(`Missing ZFS base dataset ${baseDataset}`);
  }

  if (await zfs.datasetExists(targetDataset)) {
    throw new Error(`Branch dataset already exists: ${targetDataset}`);
  }

  const snapshotName = `branch-${formatTimestamp(new Date())}`;
  const fullSnapshotName = `${pool}/${DEFAULTS.zfs.datasetBase}/${baseDataset}@${snapshotName}`;

  await zfs.createSnapshot(baseDataset, snapshotName);
  await zfs.cloneSnapshot(fullSnapshotName, targetDataset);
  await zfs.mountDataset(targetDataset);

  const mountpoint = await zfs.getMountpoint(targetDataset);
  await prepareWritableClone(mountpoint);

  const certPaths = await cert.generateCerts(PROJECT_NAME);
  const walArchivePath = wal.getArchivePath(targetDataset);
  await wal.ensureArchiveDir(targetDataset);

  const password = generatePassword();
  const image = await getSetting('replica.postgresImage') || DEFAULTS.postgres.defaultImage;

  if (!(await docker.imageExists(image))) {
    await docker.pullImage(image);
  }

  const containerId = await docker.createContainer({
    name: targetContainer,
    image,
    port: 0,
    dataPath: mountpoint,
    walArchivePath,
    sslCertDir: certPaths.certDir,
    password,
    username: 'postgres',
    database: 'postgres',
    publicAccess: true,
  });

  await docker.startContainer(containerId);
  await docker.waitForHealthy(containerId);
  const port = await docker.getContainerPort(containerId);
  const connectionUrl = formatPostgresConnectionUrl(
    'postgres',
    password,
    devServer?.host || 'localhost',
    port,
    'postgres'
  );

  await db
    .insertInto('branches')
    .values({
      project_id: project.id,
      name: branchName,
      dataset: targetDataset,
      port,
      status: 'running',
      connection_url: connectionUrl,
      source_replay_at: new Date().toISOString(),
    })
    .execute();

  const row = await db
    .selectFrom('branches')
    .select(['id', 'name', 'connection_url'])
    .where('project_id', '=', project.id)
    .where('name', '=', branchName)
    .executeTakeFirstOrThrow();

  await setStepStatus('first-branch', 'done', `${branchName} ready`);

  return {
    id: row.id,
    name: row.name,
    connectionUrl: row.connection_url || connectionUrl,
  };
}

export async function deleteBranch(input: DeleteBranchInput): Promise<DeleteBranchResult> {
  const db = getDb();
  const branch = await db
    .selectFrom('branches')
    .selectAll()
    .where('id', '=', input.id)
    .executeTakeFirstOrThrow();

  const pool = await getZFSPool();
  const zfs = new ZFSManager(pool, DEFAULTS.zfs.datasetBase);
  const docker = new DockerManager();
  const wal = new WALManager();
  const containerName = getContainerName(PROJECT_NAME, branch.name);
  const containerId = await docker.getContainerByName(containerName);
  const originSnapshot = await getOriginSnapshot(zfs, branch.dataset);

  if (containerId) {
    try {
      await docker.stopContainer(containerId);
    } catch (error: any) {
      if (error.statusCode !== 304) {
        throw error;
      }
    }

    await docker.removeContainer(containerId);
  }

  if (await zfs.datasetExists(branch.dataset)) {
    await zfs.unmountDataset(branch.dataset);
    await zfs.destroyDataset(branch.dataset, true);
  }

  if (originSnapshot) {
    await zfs.destroySnapshot(originSnapshot).catch(function ignoreSnapshotCleanupError() {});
  }

  await wal.deleteArchiveDir(branch.dataset);

  await db
    .deleteFrom('branches')
    .where('id', '=', branch.id)
    .execute();

  const remaining = await db
    .selectFrom('branches')
    .select('id')
    .limit(1)
    .executeTakeFirst();

  if (!remaining) {
    await setStepStatus('first-branch', 'pending', 'no branches yet');
  }

  return {
    id: branch.id,
    name: branch.name,
  };
}

async function getOriginSnapshot(zfs: ZFSManager, dataset: string): Promise<string | null> {
  if (!(await zfs.datasetExists(dataset))) {
    return null;
  }

  const origin = await zfs.getProperty(dataset, 'origin');

  if (!origin || origin === '-') {
    return null;
  }

  return origin;
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
      postgres_version: DEFAULTS.postgres.defaultVersion,
      database_name: 'postgres',
      app_user: 'postgres',
    })
    .execute();

  return db
    .selectFrom('projects')
    .selectAll()
    .where('name', '=', PROJECT_NAME)
    .executeTakeFirstOrThrow();
}

async function prepareWritableClone(mountpoint: string): Promise<void> {
  const pgdata = `${mountpoint}/pgdata`;
  const result = await runCommand([
    'sh',
    '-lc',
    [
      `rm -f ${shellQuote(pgdata)}/standby.signal`,
      `rm -f ${shellQuote(pgdata)}/recovery.signal`,
      `rm -f ${shellQuote(pgdata)}/postmaster.pid`,
      `if [ -f ${shellQuote(pgdata)}/postgresql.auto.conf ]; then`,
      `  sed -i.bak '/primary_conninfo/d;/primary_slot_name/d;/restore_command/d' ${shellQuote(pgdata)}/postgresql.auto.conf`,
      'fi',
      `sudo chown -R 70:70 ${shellQuote(pgdata)}`,
    ].join('\n'),
  ]);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'failed to prepare branch clone');
  }
}

function normalizeBranchName(name: string): string {
  const normalized = name.trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(normalized)) {
    throw new Error('Branch name must use lowercase letters, numbers, hyphens, or underscores');
  }

  return normalized;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
