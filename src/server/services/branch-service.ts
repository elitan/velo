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
import { cleanupOldReplicaBases, getReplicaBaseDataset, getReplicaFreshness } from './replica-service';
import { createLocalDockerBranch, deleteLocalDockerBranch, deleteLocalDockerBranchResources, isLocalDockerMode, startLocalDockerBranchContainer, stopLocalDockerBranchContainer } from './local-docker-service';
import { createJob, getActiveJobs } from './job-service';
import { getBranchConnectionHost } from './branch-network-service';
import { getReplicaBranchCreatePolicy } from '#utils/replica-freshness-policy';
import { getAvailableTcpPort } from './tcp-port-service';

const PROJECT_NAME = 'prod';

export interface CreateBranchInput {
  name: string;
  parentBranchId?: number | null;
  slug?: string;
  expiresAt?: string | null;
  ttlHours?: number | null;
  branchPassword?: string | null;
  preferredPort?: number | null;
  forceReplicaStale?: boolean;
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

export interface ReplaceBranchResult extends CreateBranchResult {
  cleanupLogs: string[];
}

export interface ReplaceBranchWithReadyBranchInput {
  targetBranchId: number;
  replacementBranchId: number;
  cleanupReplacedBranch?: (branch: ReplacedBranchResource) => Promise<string[]>;
  cleanupFailedReplacement?: (branchId: number) => Promise<void>;
}

export interface ReplacedBranchResource {
  slug: string;
  dataset: string;
  displayName: string;
}

export interface UpdateBranchExpiryInput {
  id: number;
  expiresAt: string | null;
}

export interface ProxyBranchRecord {
  id: number;
  slug: string;
  status: string;
  proxyPort: number;
  backendPort: number;
  lastActiveAt: string | null;
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
  await ensureReplicaFreshEnough(source.slug, Boolean(input.forceReplicaStale));
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
        branchPassword: input.branchPassword,
        preferredPort: input.preferredPort,
      });

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
      publicAccess: false,
      readOnly: false,
      branchPassword: input.branchPassword,
      preferredPort: input.preferredPort,
    });

    return result;
  } catch (error: any) {
    throw error;
  }
}

export async function createPreviewBranch(input: CreatePreviewBranchInput): Promise<CreateBranchResult> {
  const sourceBranch = normalizeSourceBranch(input.sourceBranch);
  const restoreTime = parseRestoreTime(input.restoreTime);
  const branchSlug = buildPreviewBranchName(sourceBranch);

  if (sourceBranch !== 'production') {
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
  branchPassword?: string | null;
  preferredPort?: number | null;
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
    if (options.sourceBranch === 'production') {
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

    const password = options.branchPassword || generatePassword();
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
    await setBranchPassword(docker, containerId, password);
    const backendPort = await docker.getContainerPort(containerId);
    const proxyPort = await getAvailableTcpPort(options.preferredPort);
    const connectionUrl = formatPostgresConnectionUrl(
      'postgres',
      password,
      getBranchConnectionHost(devServer?.host, options.publicAccess),
      proxyPort,
      'postgres'
    );

    await db
      .insertInto('branches')
      .values({
        projectId: project.id,
        slug: branchSlug,
        displayName: options.displayName,
        dataset: targetDataset,
        port: proxyPort,
        proxyPort,
        backendPort,
        status: 'running',
        parentBranchId: options.parentBranchId,
        connectionUrl: connectionUrl,
        sourceReplayAt: options.sourceReplayAt,
        expiresAt: options.expiresAt,
        lastActiveAt: new Date().toISOString(),
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

export async function resetBranchFromParent(input: DeleteBranchInput): Promise<ReplaceBranchResult> {
  const db = getDb();
  const branch = await db
    .selectFrom('branches')
    .select(['id', 'slug', 'displayName', 'parentBranchId', 'connectionUrl'])
    .where('id', '=', input.id)
    .executeTakeFirstOrThrow();
  const branchPassword = getPasswordFromConnectionUrl(branch.connectionUrl);
  const replacementSlug = buildReplacementBranchSlug(branch.slug);

  const replacement = await createBranchFromBase({
    name: branch.displayName,
    slug: replacementSlug,
    parentBranchId: branch.parentBranchId,
    branchPassword,
  });

  return replaceBranchWithReadyBranch({
    targetBranchId: branch.id,
    replacementBranchId: replacement.id,
  });
}

export async function replaceBranchWithReadyBranch(input: ReplaceBranchWithReadyBranchInput): Promise<ReplaceBranchResult> {
  const db = getDb();
  const target = await db
    .selectFrom('branches')
    .selectAll()
    .where('id', '=', input.targetBranchId)
    .executeTakeFirstOrThrow();
  const replacement = await db
    .selectFrom('branches')
    .selectAll()
    .where('id', '=', input.replacementBranchId)
    .executeTakeFirstOrThrow();
  let promoted = false;
  const keepsTargetProxy = target.proxyPort !== null;
  const promotedProxyPort = keepsTargetProxy ? target.proxyPort : replacement.proxyPort;
  const promotedPort = keepsTargetProxy ? target.port : replacement.port;
  const promotedConnectionUrl = keepsTargetProxy ? target.connectionUrl : replacement.connectionUrl;

  try {
    await assertBranchHasNoChildren(target.id);

    await db.transaction().execute(async function promoteReplacement(tx) {
      await tx
        .updateTable('branches')
        .set({
          dataset: replacement.dataset,
          port: promotedPort,
          proxyPort: promotedProxyPort,
          backendPort: replacement.backendPort ?? replacement.port,
          status: replacement.status,
          sourceReplayAt: replacement.sourceReplayAt,
          connectionUrl: promotedConnectionUrl,
          lastActiveAt: new Date().toISOString(),
          stoppedAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where('id', '=', target.id)
        .execute();

      await tx
        .deleteFrom('branches')
        .where('id', '=', replacement.id)
        .execute();
    });

    promoted = true;
  } catch (error) {
    if (input.cleanupFailedReplacement) {
      await input.cleanupFailedReplacement(replacement.id).catch(function ignoreReplacementCleanupError() {});
    } else {
      await deleteBranch({ id: replacement.id }).catch(function ignoreReplacementCleanupError() {});
    }

    throw error;
  }

  const cleanupLogs = promoted
    ? await (input.cleanupReplacedBranch || cleanupReplacedBranchResources)(target)
    : [];

  return {
    id: target.id,
    slug: target.slug,
    displayName: target.displayName,
    connectionUrl: replacement.connectionUrl || target.connectionUrl || '',
    cleanupLogs,
  };
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

export async function listProxyBranches(): Promise<ProxyBranchRecord[]> {
  const rows = await getDb()
    .selectFrom('branches')
    .select(['id', 'slug', 'status', 'proxyPort', 'backendPort', 'lastActiveAt'])
    .where('proxyPort', 'is not', null)
    .where('backendPort', 'is not', null)
    .orderBy('id')
    .execute();

  return rows.map(function mapProxyBranch(row) {
    return {
      id: row.id,
      slug: row.slug,
      status: row.status,
      proxyPort: row.proxyPort!,
      backendPort: row.backendPort!,
      lastActiveAt: row.lastActiveAt,
    };
  });
}

export async function touchBranchActivity(branchId: number): Promise<void> {
  await getDb()
    .updateTable('branches')
    .set({
      lastActiveAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where('id', '=', branchId)
    .execute();
}

export async function startBranchForProxy(branchId: number): Promise<{ id: number; backendPort: number }> {
  const branch = await getDb()
    .selectFrom('branches')
    .select(['id', 'slug', 'dataset', 'status'])
    .where('id', '=', branchId)
    .executeTakeFirstOrThrow();
  const backendPort = await ensureBranchContainerRunning(branch);

  if (branch.status !== 'stopped') {
    await getDb()
      .updateTable('branches')
      .set({
        backendPort,
        lastActiveAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where('id', '=', branch.id)
      .execute();

    return { id: branch.id, backendPort };
  }

  await getDb()
    .updateTable('branches')
    .set({
      status: 'running',
      backendPort,
      stoppedAt: null,
      lastActiveAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where('id', '=', branch.id)
    .execute();

  return { id: branch.id, backendPort };
}

async function ensureBranchContainerRunning(branch: {
  slug: string;
  dataset: string;
}): Promise<number> {
  if (isLocalDockerMode()) {
    return startLocalDockerBranchContainer(branch.dataset);
  }

  const docker = new DockerManager();
  const containerId = await getBranchContainerId(docker, branch);

  if (!containerId) {
    throw new Error(`Branch container not found: ${branch.slug}`);
  }

  await docker.startContainer(containerId).catch(function ignoreAlreadyStarted(error: any) {
    if (error.statusCode !== 304) {
      throw error;
    }
  });
  await docker.waitForHealthy(containerId);
  return docker.getContainerPort(containerId);
}

export async function stopBranchForProxy(branchId: number): Promise<{ id: number; stopped: boolean }> {
  const branch = await getDb()
    .selectFrom('branches')
    .select(['id', 'slug', 'dataset', 'status'])
    .where('id', '=', branchId)
    .executeTakeFirstOrThrow();

  if (branch.status === 'stopped') {
    return { id: branch.id, stopped: false };
  }

  if (hasActiveBranchJob(branch.id, branch.slug, await getActiveJobs())) {
    return { id: branch.id, stopped: false };
  }

  if (isLocalDockerMode()) {
    await stopLocalDockerBranchContainer(branch.dataset);
  } else {
    const docker = new DockerManager();
    const containerId = await getBranchContainerId(docker, branch);

    if (containerId) {
      await docker.stopContainer(containerId).catch(function ignoreAlreadyStopped(error: any) {
        if (error.statusCode !== 304) {
          throw error;
        }
      });
    }
  }

  await getDb()
    .updateTable('branches')
    .set({
      status: 'stopped',
      stoppedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where('id', '=', branch.id)
    .execute();

  return { id: branch.id, stopped: true };
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
        slug: 'production',
        dataset: 'postgres',
      };
    }

    return {
      id: null,
      slug: 'production',
      dataset: await getReplicaBaseDataset(),
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
  if (sourceSlug !== 'production') {
    return;
  }

  const replicaStep = await getDb()
    .selectFrom('setupSteps')
    .select(['status', 'message'])
    .where('key', '=', 'replica')
    .executeTakeFirst();

  if (replicaStep?.status === 'stale') {
    throw new Error(replicaStep.message || 'Production was restored. Rebuild the dev replica before creating a branch');
  }

  if (replicaStep?.status !== 'done') {
    throw new Error('Create the dev replica before creating a branch');
  }
}

async function ensureReplicaFreshEnough(sourceSlug: string, forced: boolean): Promise<void> {
  if (sourceSlug !== 'production') {
    return;
  }

  const policy = getReplicaBranchCreatePolicy(await getReplicaFreshness());

  if (policy.status === 'block' && !forced) {
    throw new Error(formatReplicaStaleBlockMessage(policy.lagMs));
  }
}

function formatReplicaStaleBlockMessage(lagMs: number | null): string {
  if (lagMs === null) {
    return 'Dev replica freshness is unknown. Refresh the replica or force branch creation.';
  }

  return `Dev replica is ${formatDuration(lagMs)} behind production. Force branch creation to use stale production state.`;
}

export async function deleteBranch(input: DeleteBranchInput): Promise<DeleteBranchResult> {
  const db = getDb();
  await assertBranchHasNoChildren(input.id);

  if (isLocalDockerMode()) {
    return deleteLocalDockerBranch(input.id);
  }

  const branch = await db
    .selectFrom('branches')
    .selectAll()
    .where('id', '=', input.id)
    .executeTakeFirstOrThrow();
  await deleteBranchResources(branch);

  await db
    .deleteFrom('branches')
    .where('id', '=', branch.id)
    .execute();

  return {
    id: branch.id,
    slug: branch.slug,
    displayName: branch.displayName,
  };
}

async function assertBranchHasNoChildren(branchId: number): Promise<void> {
  const child = await getDb()
    .selectFrom('branches')
    .select(['id', 'displayName'])
    .where('parentBranchId', '=', branchId)
    .executeTakeFirst();

  if (child) {
    throw new Error(`Branch has child branches. Delete ${child.displayName} first.`);
  }
}

async function cleanupReplacedBranchResources(branch: ReplacedBranchResource): Promise<string[]> {
  try {
    if (isLocalDockerMode()) {
      await deleteLocalDockerBranchResources(branch.dataset);
    } else {
      await deleteBranchResources(branch);
    }

    return [`cleaned up old branch resources for ${branch.displayName}`];
  } catch (error: any) {
    return [`replacement succeeded, but old resource cleanup failed: ${error.message || String(error)}`];
  }
}

async function deleteBranchResources(branch: {
  slug: string;
  dataset: string;
}): Promise<void> {
  const pool = await getZFSPool();
  const zfs = new ZFSManager(pool, DEFAULTS.zfs.datasetBase);
  const docker = new DockerManager();
  const wal = new WALManager();
  const containerId = await getBranchContainerId(docker, branch);
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
  await cleanupOldReplicaBases();
}

async function getBranchContainerId(docker: DockerManager, branch: {
  slug: string;
  dataset: string;
}): Promise<string | null> {
  const slugContainer = await docker.getContainerByName(getContainerName(PROJECT_NAME, branch.slug));

  if (slugContainer) {
    return slugContainer;
  }

  if (branch.dataset.startsWith(`${PROJECT_NAME}.`)) {
    return docker.getContainerByName(getContainerName(PROJECT_NAME, branch.dataset.slice(PROJECT_NAME.length + 1)));
  }

  return null;
}

async function setBranchPassword(docker: DockerManager, containerId: string, password: string): Promise<void> {
  await docker.execSQL(containerId, `alter role postgres with password ${sqlStringLiteral(password)}`);
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

  if (normalized === 'production' || normalized === 'prod') {
    throw new Error('Production is already the root branch');
  }

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

  if (normalized === 'production') {
    return normalized;
  }

  return normalizeBranchSlug(normalized);
}

function buildPreviewBranchName(sourceBranch: string): string {
  const safeSource = sourceBranch.replace(/[^a-z0-9_-]/g, '-').slice(0, 28);
  return normalizeBranchSlug(`preview-${safeSource}-${formatTimestamp(new Date())}`.slice(0, 63));
}

function buildReplacementBranchSlug(slug: string): string {
  const suffix = formatTimestamp(new Date()).toLowerCase();
  const prefix = slug.slice(0, Math.max(1, 63 - suffix.length - 5));
  return normalizeBranchSlug(`${prefix}-tmp-${suffix}`);
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

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);

  return `${hours}h`;
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

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function getPasswordFromConnectionUrl(connectionUrl: string | null): string | null {
  if (!connectionUrl) {
    return null;
  }

  try {
    return decodeURIComponent(new URL(connectionUrl).password);
  } catch {
    return null;
  }
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
