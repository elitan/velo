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
import { runCommand } from './command-service';
import { setStepStatus } from './setup-state-service';
import { createBranchFromPgBackRest } from './pgbackrest-restore-service';
import { createLocalDockerBranch, deleteLocalDockerBranch, isLocalDockerMode } from './local-docker-service';
import { createJob, getActiveJobs } from './job-service';

const PROJECT_NAME = 'prod';
const BASE_BRANCH_NAME = 'base';

export interface CreateBranchInput {
  name: string;
  parentBranchId?: number | null;
  slug?: string;
  expiresAt?: string | null;
  ttlHours?: number | null;
}

export interface CreatePreviewBranchInput {
  sourceBranch: string;
  restoreTime: string;
}

export interface CreateBranchResult {
  id: number;
  slug: string;
  displayName: string;
  connectionUrl: string;
}

export interface DeleteBranchInput {
  id: number;
}

export interface DeleteBranchResult {
  id: number;
  slug: string;
  displayName: string;
}

export interface UpdateBranchExpiryInput {
  id: number;
  expiresAt: string | null;
}

export async function createBranchFromBase(input: CreateBranchInput): Promise<CreateBranchResult> {
  const displayName = normalizeDisplayName(input.name);
  const branchSlug = normalizeBranchSlug(input.slug || input.name);
  const source = await resolveBranchSource(input.parentBranchId);
  const expiresAt = resolveExpiresAt(input);

  if (source.slug === branchSlug) {
    throw new Error('A branch cannot be created from itself');
  }

  await ensureBranchSourceReady(source.slug);
  await setStepStatus('first-branch', 'running', `creating ${displayName}`);

  try {
    if (isLocalDockerMode()) {
      const result = await createLocalDockerBranch({
        slug: branchSlug,
        displayName,
        sourceSlug: source.slug,
        sourceDatabase: source.dataset,
        sourceReplayAt: new Date().toISOString(),
        parentBranchId: source.id,
        expiresAt,
      });

      await setStepStatus('first-branch', 'done', `${displayName} ready`);

      return result;
    }

    const result = await createBranchClone({
      slug: branchSlug,
      displayName,
      sourceBranch: source.slug,
      sourceDataset: source.dataset,
      sourceReplayAt: new Date().toISOString(),
      parentBranchId: source.id,
      expiresAt,
      publicAccess: true,
      readOnly: false,
    });

    await setStepStatus('first-branch', 'done', `${displayName} ready`);

    return result;
  } catch (error: any) {
    await setStepStatus('first-branch', 'error', error?.message || 'branch create failed');
    throw error;
  }
}

export async function createPreviewBranch(input: CreatePreviewBranchInput): Promise<CreateBranchResult> {
  const sourceBranch = normalizeSourceBranch(input.sourceBranch);
  const restoreTime = parseRestoreTime(input.restoreTime);
  const branchSlug = buildPreviewBranchName(sourceBranch);

  if (sourceBranch !== 'prod') {
    throw new Error('PITR preview currently supports production as the source branch');
  }

  return createBranchFromPgBackRest({
    targetBranch: branchSlug,
    sourceBranch,
    restoreTime: restoreTime.toISOString(),
    publicAccess: false,
    readOnly: true,
  });
}

async function createBranchClone(options: {
  slug: string;
  displayName: string;
  sourceBranch: string;
  sourceDataset: string;
  sourceReplayAt: string;
  parentBranchId: number | null;
  expiresAt: string | null;
  publicAccess: boolean;
  readOnly: boolean;
}): Promise<CreateBranchResult> {
  const branchSlug = normalizeBranchSlug(options.slug);
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

  const targetDataset = getDatasetName(PROJECT_NAME, branchSlug);
  const targetContainer = getContainerName(PROJECT_NAME, branchSlug);

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

    const password = generatePassword();
    const pgVersion = await readPgVersion(`${mountpoint}/pgdata`);
    const image = `postgres:${pgVersion}-alpine`;

    if (!(await docker.imageExists(image))) {
      await docker.pullImage(image);
    }

    const postgresOwner = await resolvePostgresOwner(image);
    await setPostgresDataOwner(`${mountpoint}/pgdata`, postgresOwner);

    const certPaths = await cert.generateCerts(PROJECT_NAME, postgresOwner);
    const walArchivePath = wal.getArchivePath(targetDataset);
    await wal.ensureArchiveDir(targetDataset, postgresOwner);

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
        projectId: project.id,
        slug: branchSlug,
        displayName: options.displayName,
        dataset: targetDataset,
        port,
        status: 'running',
        parentBranchId: options.parentBranchId,
        connectionUrl: connectionUrl,
        sourceReplayAt: options.sourceReplayAt,
        expiresAt: options.expiresAt,
      })
      .execute();

    const row = await db
      .selectFrom('branches')
      .select(['id', 'slug', 'displayName', 'connectionUrl'])
      .where('projectId', '=', project.id)
      .where('slug', '=', branchSlug)
      .executeTakeFirstOrThrow();

    return {
      id: row.id,
      slug: row.slug,
      displayName: row.displayName,
      connectionUrl: row.connectionUrl || connectionUrl,
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
    .select(['id', 'slug', 'displayName', 'parentBranchId'])
    .where('id', '=', input.id)
    .executeTakeFirstOrThrow();

  await deleteBranch({ id: branch.id });

  return createBranchFromBase({
    name: branch.displayName,
    slug: branch.slug,
    parentBranchId: branch.parentBranchId,
  });
}

export async function updateBranchExpiry(input: UpdateBranchExpiryInput): Promise<void> {
  const branch = await getDb()
    .selectFrom('branches')
    .select(['id'])
    .where('id', '=', input.id)
    .executeTakeFirst();

  if (!branch) {
    throw new Error('Branch not found');
  }

  await getDb()
    .updateTable('branches')
    .set({
      expiresAt: parseOptionalExpiry(input.expiresAt),
    })
    .where('id', '=', input.id)
    .execute();
}

export async function runExpiredBranchCleanup(): Promise<void> {
  const active = await getActiveJobs();
  const expired = await getDb()
    .selectFrom('branches')
    .select(['id', 'slug', 'displayName', 'expiresAt'])
    .where('expiresAt', 'is not', null)
    .where('expiresAt', '<=', new Date().toISOString())
    .orderBy('expiresAt', 'asc')
    .execute();

  for (const branch of expired) {
    if (hasActiveBranchJob(branch.id, branch.slug, active)) {
      continue;
    }

    const child = await getDb()
      .selectFrom('branches')
      .select(['id'])
      .where('parentBranchId', '=', branch.id)
      .executeTakeFirst();

    if (child) {
      continue;
    }

    await createJob('branch-cleanup', {
      branchId: branch.id,
      branchSlug: branch.slug,
      expiresAt: branch.expiresAt,
    });
  }
}

async function resolveBranchSource(parentBranchId: number | null | undefined): Promise<{ id: number | null; slug: string; dataset: string }> {
  if (!parentBranchId) {
    if (isLocalDockerMode()) {
      return {
        id: null,
        slug: 'prod',
        dataset: 'postgres',
      };
    }

    return {
      id: null,
      slug: 'prod',
      dataset: getDatasetName(PROJECT_NAME, BASE_BRANCH_NAME),
    };
  }

  const sourceBranch = await getDb()
    .selectFrom('branches')
    .select(['id', 'slug', 'dataset'])
    .where('id', '=', parentBranchId)
    .executeTakeFirst();

  if (!sourceBranch) {
    throw new Error(`Parent branch not found: ${parentBranchId}`);
  }

  return {
    id: sourceBranch.id,
    slug: sourceBranch.slug,
    dataset: sourceBranch.dataset,
  };
}

async function ensureBranchSourceReady(sourceSlug: string): Promise<void> {
  if (sourceSlug !== 'prod') {
    return;
  }

  const replicaStep = await getDb()
    .selectFrom('setupSteps')
    .select(['status'])
    .where('key', '=', 'replica')
    .executeTakeFirst();

  if (replicaStep?.status !== 'done') {
    throw new Error('Create the dev replica before creating a branch');
  }
}

export async function deleteBranch(input: DeleteBranchInput): Promise<DeleteBranchResult> {
  const db = getDb();
  const child = await db
    .selectFrom('branches')
    .select(['id', 'displayName'])
    .where('parentBranchId', '=', input.id)
    .executeTakeFirst();

  if (child) {
    throw new Error(`Branch has child branches. Delete ${child.displayName} first.`);
  }

  if (isLocalDockerMode()) {
    return deleteLocalDockerBranch(input.id);
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
  const containerName = getContainerName(PROJECT_NAME, branch.slug);
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
    slug: branch.slug,
    displayName: branch.displayName,
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
    ].join('\n'),
  ]);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'failed to prepare branch clone');
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

export function normalizeBranchSlug(name: string): string {
  const normalized = name.trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(normalized)) {
    throw new Error('Branch name must use lowercase letters, numbers, hyphens, or underscores');
  }

  return normalized;
}

function normalizeDisplayName(name: string): string {
  const normalized = name.trim();

  if (!normalized) {
    throw new Error('Branch name is required');
  }

  return normalized;
}

function normalizeSourceBranch(name: string): string {
  const normalized = name.trim().toLowerCase();

  if (normalized === 'prod') {
    return normalized;
  }

  return normalizeBranchSlug(normalized);
}

function buildPreviewBranchName(sourceBranch: string): string {
  const safeSource = sourceBranch.replace(/[^a-z0-9_-]/g, '-').slice(0, 28);
  return normalizeBranchSlug(`preview-${safeSource}-${formatTimestamp(new Date())}`.slice(0, 63));
}

function parseRestoreTime(value: string): Date {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error('Restore time is invalid');
  }

  return date;
}

function resolveExpiresAt(input: CreateBranchInput): string | null {
  if (input.expiresAt !== undefined) {
    return parseOptionalExpiry(input.expiresAt);
  }

  if (!input.ttlHours) {
    return null;
  }

  if (!Number.isFinite(input.ttlHours) || input.ttlHours <= 0) {
    throw new Error('TTL must be greater than zero');
  }

  return new Date(Date.now() + input.ttlHours * 60 * 60 * 1000).toISOString();
}

function parseOptionalExpiry(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const expiresAt = new Date(value);

  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error('Expiry time is invalid');
  }

  return expiresAt.toISOString();
}

function hasActiveBranchJob(branchId: number, branchSlug: string, jobs: Awaited<ReturnType<typeof getActiveJobs>>): boolean {
  return jobs.some(function isBranchJob(job) {
    if (job.type === 'branch-cleanup') {
      return true;
    }

    if (!job.inputJson) {
      return false;
    }

    try {
      const input = JSON.parse(job.inputJson) as Record<string, unknown>;
      return input.id === branchId || input.branchId === branchId || input.targetBranch === branchSlug;
    } catch {
      return false;
    }
  });
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
