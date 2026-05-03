import { sql } from 'kysely';
import { getDb } from '../../db/client';
import type { Server } from '../../db/schema';
import { runCommand, runSshCommand } from './command-service';
import { listJobs, type JobRecord } from './job-service';
import { getBackupAvailability, type BackupAvailability } from './backup-availability-service';
import { getBackupSettings, getSetting, type BackupSettings } from './settings-service';
import { checkLocalDocker, isLocalDockerMode } from './local-docker-service';
import { getAppAuthState, type AppAuthState } from './app-auth-service';
import { getCurrentProject } from './project-service';
import type { Project } from '#db/schema';

const SETUP_STEP_ORDER = [
  'app-password',
  'project',
  'dev-check',
  'prod-check',
  'backups-config',
  'prod-setup',
  'backups',
  'replica',
  'first-branch',
];

export interface ServerInput {
  role: 'prod' | 'dev';
  host: string;
  sshUser: string;
  sshKeyPath: string;
}

export interface ControlPlaneState {
  servers: Server[];
  setupSteps: Array<{
    key: string;
    label: string;
    status: string;
    message: string | null;
    updatedAt: string;
  }>;
  branches: Array<{
    id: number;
    slug: string;
    displayName: string;
    status: string;
    parentBranchId: number | null;
    parentName: string | null;
    parentSlug: string | null;
    port: number | null;
    connectionUrl: string | null;
    expiresAt: string | null;
    createdAt: string;
  }>;
  project: Project | null;
  appAuth: AppAuthState;
  jobs: JobRecord[];
  backup: BackupSettings;
  backupAvailability: BackupAvailability;
  prodConnectionUrl: string | null;
}

export async function getControlPlaneState(): Promise<ControlPlaneState> {
  const db = getDb();
  await syncDerivedOnboardingSteps();

  const [servers, setupSteps, branches, project, appAuth, jobs, backup, backupAvailability, prodConnectionUrl] = await Promise.all([
    db.selectFrom('servers').selectAll().orderBy('role').execute(),
    db
      .selectFrom('setupSteps')
      .select(['key', 'label', 'status', 'message', 'updatedAt'])
      .execute(),
    db
      .selectFrom('branches')
      .leftJoin('branches as parent', 'parent.id', 'branches.parentBranchId')
      .select([
        'branches.id',
        'branches.slug',
        'branches.displayName',
        'branches.status',
        'branches.parentBranchId',
        'parent.displayName as parentName',
        'parent.slug as parentSlug',
        'branches.port',
        'branches.connectionUrl',
        'branches.expiresAt',
        'branches.createdAt',
      ])
      .where('branches.slug', 'not like', 'preview-%')
      .orderBy('branches.createdAt', 'desc')
      .execute(),
    getCurrentProject(),
    getAppAuthState(),
    listJobs(10),
    getBackupSettings(),
    getBackupAvailability(),
    getSetting('prod.connectionUrl'),
  ]);

  return {
    servers,
    setupSteps: sortSetupSteps(setupSteps),
    branches,
    project,
    appAuth,
    jobs,
    backup,
    backupAvailability,
    prodConnectionUrl,
  };
}

export async function saveServer(input: ServerInput): Promise<Server> {
  const db = getDb();
  const host = input.host.trim();
  const sshUser = input.sshUser.trim();
  const sshKeyPath = input.sshKeyPath.trim();

  if (!host) {
    throw new Error('Host is required');
  }

  if (!sshUser) {
    throw new Error('SSH user is required');
  }

  if (!sshKeyPath) {
    throw new Error('SSH key path is required');
  }

  await db
    .insertInto('servers')
    .values({
      role: input.role,
      host,
      sshUser,
      sshKeyPath,
      status: 'unknown',
      statusMessage: null,
      lastCheckedAt: null,
    })
    .onConflict(function updateExisting(oc) {
      return oc.column('role').doUpdateSet({
        host,
        sshUser,
        sshKeyPath,
        status: 'unknown',
        statusMessage: null,
        updatedAt: sql`datetime('now')`,
      });
    })
    .execute();

  const server = await db
    .selectFrom('servers')
    .selectAll()
    .where('role', '=', input.role)
    .executeTakeFirstOrThrow();

  return server;
}

export async function checkServer(role: 'prod' | 'dev'): Promise<Server> {
  if (isLocalDockerMode()) {
    return checkLocalDocker(role);
  }

  const db = getDb();
  const server = await db
    .selectFrom('servers')
    .selectAll()
    .where('role', '=', role)
    .executeTakeFirstOrThrow();

  const result = role === 'dev'
    ? await runCommand(['sh', '-lc', 'uname -srm && id -un && command -v sudo >/dev/null && echo sudo-ok'])
    : await runSshCommand(
      {
        host: server.host,
        user: server.sshUser,
        keyPath: server.sshKeyPath,
      },
      'uname -srm && id -un && command -v sudo >/dev/null && echo sudo-ok'
    );

  const ok = result.exitCode === 0;
  const message = ok ? result.stdout : result.stderr || result.stdout || 'check failed';

  await db
    .updateTable('servers')
    .set({
      status: ok ? 'ok' : 'error',
      statusMessage: message,
      lastCheckedAt: new Date().toISOString(),
      updatedAt: sql`datetime('now')`,
    })
    .where('id', '=', server.id)
    .execute();

  await setStepStatus(role === 'dev' ? 'dev-check' : 'prod-check', ok ? 'done' : 'error', message);

  return db
    .selectFrom('servers')
    .selectAll()
    .where('id', '=', server.id)
    .executeTakeFirstOrThrow();
}

export async function setStepStatus(
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

async function syncDerivedOnboardingSteps(): Promise<void> {
  const [project, appAuth] = await Promise.all([
    getCurrentProject(),
    getAppAuthState(),
  ]);

  if (project) {
    await markStepDoneIfNeeded('project', 'project saved');
  }

  if (appAuth.configured) {
    await markStepDoneIfNeeded('app-password', appAuth.envConfigured ? 'app password set by env' : 'app password saved');
  }
}

async function markStepDoneIfNeeded(key: string, message: string): Promise<void> {
  const step = await getDb()
    .selectFrom('setupSteps')
    .select('status')
    .where('key', '=', key)
    .executeTakeFirst();

  if (step?.status === 'done') {
    return;
  }

  await setStepStatus(key, 'done', message);
}

function sortSetupSteps<T extends { key: string }>(steps: T[]): T[] {
  return steps.slice().sort(function sortBySetupOrder(first, second) {
    return getSetupStepIndex(first.key) - getSetupStepIndex(second.key);
  });
}

function getSetupStepIndex(key: string): number {
  const index = SETUP_STEP_ORDER.indexOf(key);

  return index === -1 ? SETUP_STEP_ORDER.length : index;
}
