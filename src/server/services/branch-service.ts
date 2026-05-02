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
import { setStepStatus } from './setup-state-service';
import { createBranchFromPgBackRest } from './pgbackrest-restore-service';

const PROJECT_NAME = 'prod';
const BASE_BRANCH_NAME = 'base';

export interface CreateBranchInput {
  name: string;
  parentBranchId?: number | null;
}

export interface CreatePreviewBranchInput {
  sourceBranch: string;
  restoreTime: string;
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
  const source = await resolveBranchSource(input.parentBranchId);

  if (source.name === branchName) {
    throw new Error('A branch cannot be created from itself');
  }

  await setStepStatus('first-branch', 'running', `creating ${branchName}`);

  const result = await createBranchClone({
    name: branchName,
    sourceBranch: source.name,
    sourceDataset: source.dataset,
    sourceReplayAt: new Date().toISOString(),
    parentBranchId: source.id,
    publicAccess: true,
    readOnly: false,
  });

  await setStepStatus('first-branch', 'done', `${branchName} ready`);

  return result;
}

export async function createPreviewBranch(input: CreatePreviewBranchInput): Promise<CreateBranchResult> {
  const sourceBranch = normalizeSourceBranch(input.sourceBranch);
  const restoreTime = parseRestoreTime(input.restoreTime);
  const branchName = buildPreviewBranchName(sourceBranch);

  if (sourceBranch !== 'prod') {
    throw new Error('PITR preview currently supports production as the source branch');
  }

  return createBranchFromPgBackRest({
    targetBranch: branchName,
    sourceBranch,
    restoreTime: restoreTime.toISOString(),
    publicAccess: false,
    readOnly: true,
  });
}

async function createBranchClone(options: {
  name: string;
  sourceBranch: string;
  sourceDataset: string;
  sourceReplayAt: string;
  parentBranchId: number | null;
  publicAccess: boolean;
  readOnly: boolean;
}): Promise<CreateBranchResult> {
  const branchName = normalizeBranchName(options.name);
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

  const targetDataset = getDatasetName(PROJECT_NAME, branchName);
  const targetContainer = getContainerName(PROJECT_NAME, branchName);

  if (!(await zfs.datasetExists(options.sourceDataset))) {
    if (options.sourceBranch === 'prod') {
      await setStepStatus('replica', 'error', `missing ZFS base dataset ${options.sourceDataset}`);
    }
    throw new Error(`Missing ZFS source dataset ${options.sourceDataset}`);
  }

  if (await zfs.datasetExists(targetDataset)) {
    throw new Error(`Branch dataset already exists: ${targetDataset}`);
  }

  const snapshotName = `branch-${formatTimestamp(new Date())}`;
  const fullSnapshotName = `${pool}/${DEFAULTS.zfs.datasetBase}/${options.sourceDataset}@${snapshotName}`;
  let containerId: string | null = null;

  try {
    await zfs.createSnapshot(options.sourceDataset, snapshotName);
    await zfs.cloneSnapshot(fullSnapshotName, targetDataset);
    await zfs.mountDataset(targetDataset);

    const mountpoint = await zfs.getMountpoint(targetDataset);
    await prepareWritableClone(mountpoint);

    const certPaths = await cert.generateCerts(PROJECT_NAME);
    const walArchivePath = wal.getArchivePath(targetDataset);
    await wal.ensureArchiveDir(targetDataset);

    const password = generatePassword();
    const pgVersion = await readPgVersion(`${mountpoint}/pgdata`);
    const image = `postgres:${pgVersion}-alpine`;

    if (!(await docker.imageExists(image))) {
      await docker.pullImage(image);
    }

    containerId = await docker.createContainer({
      name: targetContainer,
      image,
      port: 0,
      dataPath: mountpoint,
      walArchivePath,
      sslCertDir: certPaths.certDir,
      password,
      username: 'postgres',
      database: 'postgres',
      publicAccess: options.publicAccess,
      readOnly: options.readOnly,
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
        parent_branch_id: options.parentBranchId,
        connection_url: connectionUrl,
        source_replay_at: options.sourceReplayAt,
      })
      .execute();

    const row = await db
      .selectFrom('branches')
      .select(['id', 'name', 'connection_url'])
      .where('project_id', '=', project.id)
      .where('name', '=', branchName)
      .executeTakeFirstOrThrow();

    return {
      id: row.id,
      name: row.name,
      connectionUrl: row.connection_url || connectionUrl,
    };
  } catch (error) {
    await cleanupFailedClone({
      docker,
      zfs,
      wal,
      containerId,
      containerName: targetContainer,
      dataset: targetDataset,
      snapshot: fullSnapshotName,
    });
    throw error;
  }
}

export async function resetBranchFromParent(input: DeleteBranchInput): Promise<CreateBranchResult> {
  const db = getDb();
  const branch = await db
    .selectFrom('branches')
    .select(['id', 'name', 'parent_branch_id as parentBranchId'])
    .where('id', '=', input.id)
    .executeTakeFirstOrThrow();

  await deleteBranch({ id: branch.id });

  return createBranchFromBase({
    name: branch.name,
    parentBranchId: branch.parentBranchId,
  });
}

async function resolveBranchSource(parentBranchId: number | null | undefined): Promise<{ id: number | null; name: string; dataset: string }> {
  if (!parentBranchId) {
    return {
      id: null,
      name: 'prod',
      dataset: getDatasetName(PROJECT_NAME, BASE_BRANCH_NAME),
    };
  }

  const sourceBranch = await getDb()
    .selectFrom('branches')
    .select(['id', 'name', 'dataset'])
    .where('id', '=', parentBranchId)
    .executeTakeFirst();

  if (!sourceBranch) {
    throw new Error(`Parent branch not found: ${parentBranchId}`);
  }

  return {
    id: sourceBranch.id,
    name: sourceBranch.name,
    dataset: sourceBranch.dataset,
  };
}

export async function deleteBranch(input: DeleteBranchInput): Promise<DeleteBranchResult> {
  const db = getDb();
  const child = await db
    .selectFrom('branches')
    .select(['id', 'name'])
    .where('parent_branch_id', '=', input.id)
    .executeTakeFirst();

  if (child) {
    throw new Error(`Branch has child branches. Delete ${child.name} first.`);
  }

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

async function readPgVersion(pgdata: string): Promise<string> {
  const result = await runCommand(['sh', '-lc', `cat ${shellQuote(pgdata)}/PG_VERSION`]);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'could not read PG_VERSION');
  }

  return result.stdout.trim().split('.')[0] || DEFAULTS.postgres.defaultVersion;
}

async function cleanupFailedClone(options: {
  docker: DockerManager;
  zfs: ZFSManager;
  wal: WALManager;
  containerId: string | null;
  containerName: string;
  dataset: string;
  snapshot: string;
}): Promise<void> {
  const containerId = options.containerId || await options.docker.getContainerByName(options.containerName);

  if (containerId) {
    await options.docker.removeContainer(containerId).catch(function ignoreContainerCleanupError() {});
  }

  await options.zfs.unmountDataset(options.dataset).catch(function ignoreUnmountCleanupError() {});

  if (await options.zfs.datasetExists(options.dataset)) {
    await options.zfs.destroyDataset(options.dataset, true).catch(function ignoreDatasetCleanupError() {});
  }

  await options.zfs.destroySnapshot(options.snapshot).catch(function ignoreSnapshotCleanupError() {});
  await options.wal.deleteArchiveDir(options.dataset).catch(function ignoreWalCleanupError() {});
}

function normalizeBranchName(name: string): string {
  const normalized = name.trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(normalized)) {
    throw new Error('Branch name must use lowercase letters, numbers, hyphens, or underscores');
  }

  return normalized;
}

function normalizeSourceBranch(name: string): string {
  const normalized = name.trim().toLowerCase();

  if (normalized === 'prod') {
    return normalized;
  }

  return normalizeBranchName(normalized);
}

function buildPreviewBranchName(sourceBranch: string): string {
  const safeSource = sourceBranch.replace(/[^a-z0-9_-]/g, '-').slice(0, 28);
  return normalizeBranchName(`preview-${safeSource}-${formatTimestamp(new Date())}`.slice(0, 63));
}

function parseRestoreTime(value: string): Date {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error('Restore time is invalid');
  }

  return date;
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
