import { sql } from 'kysely';
import { getDb } from '../../db/client';
import { runCommand } from './command-service';
import { saveBackupSettings, setSetting } from './settings-service';

const COMPOSE_FILE = process.env.VELO_LOCAL_COMPOSE_FILE || 'docker-compose.local.yml';
const LOCAL_PGBACKREST_IMAGE = 'velo-local-postgres-pgbackrest:17';
const PROJECT_NAME = 'prod';

export interface LocalDockerBranchInput {
  slug: string;
  displayName: string;
  sourceSlug: string;
  sourceDatabase: string;
  sourceReplayAt: string;
  parentBranchId: number | null;
  expiresAt: string | null;
}

export interface LocalDockerBranchResult {
  id: number;
  slug: string;
  displayName: string;
  connectionUrl: string;
}

export interface LocalDockerRestoreInput {
  targetBranch: string;
  restoreTime: string;
  readOnly?: boolean;
  publicAccess?: boolean;
}

export function isLocalDockerMode(): boolean {
  return process.env.VELO_LOCAL_DOCKER === '1';
}

export async function seedLocalDockerState(): Promise<void> {
  await saveLocalServer({
    role: 'prod',
    host: 'localhost',
    sshUser: 'docker',
    sshKeyPath: 'docker',
  });
  await saveLocalServer({
    role: 'dev',
    host: 'localhost',
    sshUser: 'docker',
    sshKeyPath: 'docker',
  });

  await saveBackupSettings({
    enabled: true,
    endpoint: `https://localhost:${await getServicePort('minio')}`,
    bucket: 'velo-dev',
    region: 'auto',
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
    path: '/prod',
    pitrDays: 7,
    fullBackupRetentionDays: 90,
  });

  await setSetting('prod.password', 'postgres');
  await setSetting('prod.connectionUrl', await formatProdConnectionUrl());
  await setSetting('replica.baseDataset', 'postgres');

  await Promise.all([
    setLocalStepStatus('dev-check', 'done', 'local Docker dev Postgres ready'),
    setLocalStepStatus('prod-check', 'done', 'local Docker prod Postgres ready'),
    setLocalStepStatus('prod-setup', 'done', 'local Docker prod Postgres ready'),
    setLocalStepStatus('backups', 'done', 'local MinIO configured'),
    setLocalStepStatus('replica', 'done', 'local dev Postgres ready'),
  ]);
}

export async function checkLocalDocker(role: 'prod' | 'dev') {
  const service = role === 'prod' ? 'prod-postgres' : 'dev-postgres';
  const result = await composeExec(service, 'pg_isready -U postgres -d postgres');
  const ok = result.exitCode === 0;
  const message = ok ? result.stdout : result.stderr || result.stdout || `${role} check failed`;

  await getDb()
    .updateTable('servers')
    .set({
      status: ok ? 'ok' : 'error',
      statusMessage: message,
      lastCheckedAt: new Date().toISOString(),
      updatedAt: sql`datetime('now')`,
    })
    .where('role', '=', role)
    .execute();

  await setLocalStepStatus(role === 'dev' ? 'dev-check' : 'prod-check', ok ? 'done' : 'error', message);

  return getDb()
    .selectFrom('servers')
    .selectAll()
    .where('role', '=', role)
    .executeTakeFirstOrThrow();
}

export async function bootstrapLocalDocker(role: 'prod' | 'dev') {
  await seedLocalDockerState();
  await checkLocalDocker(role);

  return {
    ok: true,
    message: role === 'prod' ? 'local Docker prod ready' : 'local Docker dev ready',
  };
}

export async function createLocalDockerReplicaBase() {
  await seedLocalDockerState();
  await setLocalStepStatus('replica', 'done', 'local dev Postgres ready');

  return {
    ok: true,
    message: 'local dev Postgres ready',
  };
}

export async function createLocalDockerBranch(input: LocalDockerBranchInput): Promise<LocalDockerBranchResult> {
  const database = getLocalDatabaseName(input.slug);
  const db = getDb();
  const project = await ensureProject();
  const existing = await db
    .selectFrom('branches')
    .select('id')
    .where('projectId', '=', project.id)
    .where('slug', '=', input.slug)
    .executeTakeFirst();

  if (existing) {
    throw new Error(`Branch already exists: ${input.slug}`);
  }

  await dropDevDatabase(database);
  await createDevDatabase(database);

  if (input.sourceSlug === 'prod') {
    await copyProdToDevDatabase(database);
  } else {
    await copyDevDatabase(input.sourceDatabase, database);
  }

  const connectionUrl = await formatDevConnectionUrl(database);

  await db
    .insertInto('branches')
    .values({
      projectId: project.id,
      slug: input.slug,
      displayName: input.displayName,
      dataset: database,
      port: await getServicePort('dev-postgres'),
      status: 'running',
      parentBranchId: input.parentBranchId,
      connectionUrl: connectionUrl,
      sourceReplayAt: input.sourceReplayAt,
      expiresAt: input.expiresAt,
    })
    .execute();

  const row = await db
    .selectFrom('branches')
    .select(['id', 'slug', 'displayName', 'connectionUrl'])
    .where('projectId', '=', project.id)
    .where('slug', '=', input.slug)
    .executeTakeFirstOrThrow();

  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    connectionUrl: row.connectionUrl || connectionUrl,
  };
}

export async function deleteLocalDockerBranch(id: number) {
  const db = getDb();
  const branch = await db
    .selectFrom('branches')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

  if (branch.dataset.startsWith('container:')) {
    await deleteRestoreContainer(branch.dataset);
  } else {
    await dropDevDatabase(branch.dataset);
  }

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

export async function createLocalDockerPitrBranch(input: LocalDockerRestoreInput): Promise<LocalDockerBranchResult> {
  const branchSlug = normalizeBranchSlug(input.targetBranch);
  const restoreTime = parseRestoreTime(input.restoreTime);
  const db = getDb();
  const project = await ensureProject();
  const existing = await db
    .selectFrom('branches')
    .select('id')
    .where('projectId', '=', project.id)
    .where('slug', '=', branchSlug)
    .executeTakeFirst();

  if (existing) {
    throw new Error(`Branch already exists: ${branchSlug}`);
  }

  const containerName = getRestoreContainerName(branchSlug);
  const volumeName = getRestoreVolumeName(branchSlug);
  const dataset = `container:${containerName}`;

  await removeContainer(containerName);
  await removeVolume(volumeName);
  await createVolume(volumeName);
  await restorePgBackRestVolume(volumeName, restoreTime);
  await startRestoreContainer({
    containerName,
    volumeName,
    readOnly: input.readOnly === true,
    publicAccess: input.publicAccess === true,
  });

  const port = await getContainerPort(containerName);
  const connectionUrl = `postgresql://postgres:postgres@localhost:${port}/postgres?sslmode=disable`;

  await db
    .insertInto('branches')
    .values({
      projectId: project.id,
      slug: branchSlug,
      displayName: branchSlug,
      dataset,
      port,
      status: 'running',
      parentBranchId: null,
      connectionUrl: connectionUrl,
      sourceReplayAt: restoreTime.toISOString(),
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
}

export async function restoreLocalDockerProduction(input: LocalDockerRestoreInput): Promise<void> {
  const restoreTime = parseRestoreTime(input.restoreTime);
  await runLocalCommand(`docker compose -f ${shellQuote(COMPOSE_FILE)} stop prod-postgres`, 60_000);
  await runLocalCommand(`docker compose -f ${shellQuote(COMPOSE_FILE)} rm -f prod-postgres`, 60_000);
  await runLocalCommand('docker volume rm velo_velo-local-prod-data >/dev/null 2>&1 || true');
  await runLocalCommand('docker volume create velo_velo-local-prod-data >/dev/null');
  await restorePgBackRestVolume('velo_velo-local-prod-data', restoreTime);
  await runLocalCommand(`docker compose -f ${shellQuote(COMPOSE_FILE)} up -d prod-postgres`, 60_000);
  await composeExec('prod-postgres', 'pg_isready -U postgres -d postgres', 60_000);
  await setSetting('prod.lastRestoreAt', restoreTime.toISOString());
}

export async function getLocalPgBackRestInfo(): Promise<string> {
  const result = await runCommand([
    'sh',
    '-lc',
    `docker compose -f ${shellQuote(COMPOSE_FILE)} exec -T --user postgres prod-postgres pgbackrest --config=/etc/pgbackrest.conf --stanza=main info --output=json`,
  ], 30_000);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'local pgBackRest info failed');
  }

  return result.stdout;
}

async function saveLocalServer(input: {
  role: 'prod' | 'dev';
  host: string;
  sshUser: string;
  sshKeyPath: string;
}): Promise<void> {
  await getDb()
    .insertInto('servers')
    .values({
      role: input.role,
      host: input.host,
      sshUser: input.sshUser,
      sshKeyPath: input.sshKeyPath,
      status: 'ok',
      statusMessage: 'local Docker',
      lastCheckedAt: new Date().toISOString(),
    })
    .onConflict(function updateExisting(oc) {
      return oc.column('role').doUpdateSet({
        host: input.host,
        sshUser: input.sshUser,
        sshKeyPath: input.sshKeyPath,
        status: 'ok',
        statusMessage: 'local Docker',
        lastCheckedAt: new Date().toISOString(),
        updatedAt: sql`datetime('now')`,
      });
    })
    .execute();
}

async function setLocalStepStatus(
  key: string,
  status: 'pending' | 'running' | 'done' | 'error',
  message: string | null
): Promise<void> {
  await getDb()
    .updateTable('setupSteps')
    .set({
      status,
      message,
      updatedAt: sql`datetime('now')`,
    })
    .where('key', '=', key)
    .execute();
}

function getLocalDatabaseName(slug: string): string {
  return `velo_${slug.replace(/[^a-z0-9_]/g, '_')}`.slice(0, 63);
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
      postgresVersion: '17',
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

async function createDevDatabase(database: string): Promise<void> {
  await runLocalCommand(`docker compose -f ${shellQuote(COMPOSE_FILE)} exec -T dev-postgres createdb -U postgres ${shellQuote(database)}`);
}

async function dropDevDatabase(database: string): Promise<void> {
  await runLocalCommand(`docker compose -f ${shellQuote(COMPOSE_FILE)} exec -T dev-postgres dropdb -U postgres --if-exists --force ${shellQuote(database)}`);
}

async function copyProdToDevDatabase(targetDatabase: string): Promise<void> {
  await runLocalCommand([
    `docker compose -f ${shellQuote(COMPOSE_FILE)} exec -T prod-postgres pg_dump -U postgres -d postgres`,
    `docker compose -f ${shellQuote(COMPOSE_FILE)} exec -T dev-postgres psql -v ON_ERROR_STOP=1 -U postgres -d ${shellQuote(targetDatabase)}`,
  ].join(' | '), 10 * 60 * 1000);
}

async function copyDevDatabase(sourceDatabase: string, targetDatabase: string): Promise<void> {
  await runLocalCommand([
    `docker compose -f ${shellQuote(COMPOSE_FILE)} exec -T dev-postgres pg_dump -U postgres -d ${shellQuote(sourceDatabase)}`,
    `docker compose -f ${shellQuote(COMPOSE_FILE)} exec -T dev-postgres psql -v ON_ERROR_STOP=1 -U postgres -d ${shellQuote(targetDatabase)}`,
  ].join(' | '), 10 * 60 * 1000);
}

async function composeExec(service: string, command: string, timeoutMs = 15_000) {
  return runCommand([
    'sh',
    '-lc',
    `docker compose -f ${shellQuote(COMPOSE_FILE)} exec -T ${shellQuote(service)} ${command}`,
  ], timeoutMs);
}

async function runLocalCommand(command: string, timeoutMs = 60_000): Promise<void> {
  const result = await runCommand(['sh', '-lc', command], timeoutMs);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `local Docker command failed: ${command}`);
  }
}

async function formatProdConnectionUrl(): Promise<string> {
  return `postgresql://postgres:postgres@localhost:${await getServicePort('prod-postgres')}/postgres?sslmode=disable`;
}

async function formatDevConnectionUrl(database: string): Promise<string> {
  return `postgresql://postgres:postgres@localhost:${await getServicePort('dev-postgres')}/${encodeURIComponent(database)}?sslmode=disable`;
}

async function restorePgBackRestVolume(volumeName: string, restoreTime: Date): Promise<void> {
  const target = formatPgBackRestTime(restoreTime);

  await runLocalCommand([
    `docker run --rm`,
    `--network ${shellQuote(getComposeNetworkName())}`,
    `-v ${shellQuote(volumeName)}:/var/lib/postgresql/data`,
    `-v ${shellQuote(`${process.cwd()}/docker/local-pgbackrest/pgbackrest.conf`)}:/etc/pgbackrest.conf:ro`,
    shellQuote(LOCAL_PGBACKREST_IMAGE),
    'sh -lc',
    shellQuote([
      'rm -rf /var/lib/postgresql/data/*',
      `pgbackrest --config=/etc/pgbackrest.conf --stanza=main --pg1-path=/var/lib/postgresql/data --type=time --target=${shellQuote(target)} --target-action=promote restore`,
      'rm -f /var/lib/postgresql/data/postmaster.pid',
      'chown -R postgres:postgres /var/lib/postgresql/data',
    ].join(' && ')),
  ].join(' '), 60 * 60 * 1000);
}

async function startRestoreContainer(options: {
  containerName: string;
  volumeName: string;
  readOnly: boolean;
  publicAccess: boolean;
}): Promise<void> {
  const hostIp = options.publicAccess ? '0.0.0.0' : '127.0.0.1';
  const readonlyArgs = options.readOnly ? '-c default_transaction_read_only=on' : '';

  await runLocalCommand([
    'docker run -d',
    `--name ${shellQuote(options.containerName)}`,
    `--network ${shellQuote(getComposeNetworkName())}`,
    `-p ${hostIp}::5432`,
    `-v ${shellQuote(options.volumeName)}:/var/lib/postgresql/data`,
    `-v ${shellQuote(`${process.cwd()}/docker/local-pgbackrest/pgbackrest.conf`)}:/etc/pgbackrest.conf:ro`,
    `-e POSTGRES_PASSWORD=postgres`,
    shellQuote(LOCAL_PGBACKREST_IMAGE),
    'postgres',
    '-c listen_addresses=*',
    readonlyArgs,
  ].filter(Boolean).join(' '), 60_000);

  await waitForContainer(options.containerName);
}

async function waitForContainer(containerName: string): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 60_000) {
    const result = await runCommand([
      'sh',
      '-lc',
      `docker exec ${shellQuote(containerName)} pg_isready -U postgres -d postgres`,
    ]);

    if (result.exitCode === 0) {
      return;
    }

    const state = await runCommand([
      'sh',
      '-lc',
      `docker inspect -f '{{.State.Status}}' ${shellQuote(containerName)} 2>/dev/null || true`,
    ]);

    if (state.stdout === 'exited' || state.stdout === 'dead') {
      const logs = await runCommand([
        'sh',
        '-lc',
        `docker logs --tail 40 ${shellQuote(containerName)} 2>&1`,
      ]);
      throw new Error(logs.stdout || `${containerName} exited before it was ready`);
    }

    await Bun.sleep(250);
  }

  throw new Error(`Container ${containerName} did not become ready`);
}

async function createVolume(volumeName: string): Promise<void> {
  await runLocalCommand(`docker volume create ${shellQuote(volumeName)} >/dev/null`);
}

async function removeVolume(volumeName: string): Promise<void> {
  await runLocalCommand(`docker volume rm ${shellQuote(volumeName)} >/dev/null 2>&1 || true`);
}

async function removeContainer(containerName: string): Promise<void> {
  await runLocalCommand(`docker rm -f ${shellQuote(containerName)} >/dev/null 2>&1 || true`);
}

async function deleteRestoreContainer(dataset: string): Promise<void> {
  const containerName = dataset.replace(/^container:/, '');
  await removeContainer(containerName);
  await removeVolume(containerName);
}

async function getContainerPort(containerName: string): Promise<number> {
  const result = await runCommand([
    'sh',
    '-lc',
    `docker inspect -f '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' ${shellQuote(containerName)}`,
  ]);

  if (result.exitCode !== 0 || !result.stdout) {
    throw new Error(result.stderr || result.stdout || `could not read port for ${containerName}`);
  }

  return Number(result.stdout);
}

function getRestoreContainerName(slug: string): string {
  return `${getComposeProjectName()}-restore-${slug}`;
}

function getRestoreVolumeName(slug: string): string {
  return `${getComposeProjectName()}-restore-${slug}`;
}

function getComposeNetworkName(): string {
  return process.env.VELO_LOCAL_DOCKER_NETWORK || `${getComposeProjectName()}_default`;
}

function getComposeProjectName(): string {
  return process.env.VELO_LOCAL_COMPOSE_PROJECT || process.env.COMPOSE_PROJECT_NAME || 'velo';
}

async function getServicePort(service: 'prod-postgres' | 'dev-postgres' | 'minio'): Promise<number> {
  const result = await runCommand([
    'sh',
    '-lc',
    `docker compose -f ${shellQuote(COMPOSE_FILE)} port ${shellQuote(service)} ${service === 'minio' ? '9000' : '5432'} | sed 's/.*://'`,
  ]);

  if (result.exitCode !== 0 || !result.stdout) {
    throw new Error(result.stderr || result.stdout || `could not read local ${service} port`);
  }

  return Number(result.stdout);
}

function normalizeBranchSlug(name: string): string {
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

function formatPgBackRestTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '+00');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
