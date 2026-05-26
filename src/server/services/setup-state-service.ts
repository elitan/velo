import { sql } from 'kysely';
import { getDb } from '../../db/client';
import type { Server } from '../../db/schema';
import { runCommand, runSshCommand } from './command-service';
import { getCurrentJobId, listJobs, type JobRecord } from './job-service';
import { getBackupAvailability, type BackupAvailability } from './backup-availability-service';
import { getBackupSettings, getSetting, type BackupSettings } from './settings-service';
import { checkLocalDocker, isLocalDockerMode } from './local-docker-service';
import { getProdAllowedCidr, saveProdAllowedCidr } from './prod-network-service';
import { getReplicaFreshness, type ReplicaFreshness } from './replica-service';
import { listBranchRecords, type BranchRecord } from './branch-read-service';

export interface ServerInput {
  role: 'prod' | 'dev';
  host: string;
  sshUser: string;
  sshKeyPath: string;
  allowedCidr?: string;
}

export interface ControlPlaneState {
  servers: Server[];
  setupSteps: Array<{
    key: string;
    label: string;
    status: string;
    message: string | null;
    failedJobId: number | null;
    updatedAt: string;
  }>;
  branches: BranchRecord[];
  jobs: JobRecord[];
  backup: BackupSettings;
  backupAvailability: BackupAvailability;
  replicaFreshness: ReplicaFreshness | null;
  prodConnectionUrl: string | null;
  prodAllowedCidr: string | null;
}

export type SetupStepStatus = 'pending' | 'running' | 'done' | 'error' | 'stale';

export async function getControlPlaneState(): Promise<ControlPlaneState> {
  const db = getDb();
  const [servers, setupSteps, branches, jobs, backup, backupAvailability, replicaFreshness, prodConnectionUrl, prodAllowedCidr] = await Promise.all([
    db.selectFrom('servers').selectAll().orderBy('role').execute(),
    db
      .selectFrom('setupSteps')
      .select(['key', 'label', 'status', 'message', 'failedJobId', 'updatedAt'])
      .orderBy('id')
      .execute(),
    listBranchRecords(),
    listJobs(10),
    getBackupSettings(),
    getBackupAvailability(),
    getReplicaFreshness().catch(function ignoreReplicaFreshnessError() {
      return null;
    }),
    getSetting('prod.connectionUrl'),
    getProdAllowedCidr().catch(function ignoreMissingCidr() {
      return null;
    }),
  ]);

  return { servers, setupSteps, branches, jobs, backup, backupAvailability, replicaFreshness, prodConnectionUrl, prodAllowedCidr };
}

export async function saveServer(input: ServerInput): Promise<Server> {
  const db = getDb();

  await db
    .insertInto('servers')
    .values({
      role: input.role,
      host: input.host,
      sshUser: input.sshUser,
      sshKeyPath: input.sshKeyPath,
      status: 'unknown',
      statusMessage: null,
      lastCheckedAt: null,
    })
    .onConflict(function updateExisting(oc) {
      return oc.column('role').doUpdateSet({
        host: input.host,
        sshUser: input.sshUser,
        sshKeyPath: input.sshKeyPath,
        status: 'unknown',
        statusMessage: null,
        updatedAt: sql`datetime('now')`,
      });
    })
    .execute();

  if (input.role === 'prod' && input.allowedCidr) {
    await saveProdAllowedCidr(input.allowedCidr);
  }

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
  status: SetupStepStatus,
  message: string | null
): Promise<void> {
  const failedJobId = status === 'error' ? getCurrentJobId() : null;

  await getDb()
    .updateTable('setupSteps')
    .set({
      status,
      message,
      failedJobId,
      updatedAt: sql`datetime('now')`,
    })
    .where('key', '=', key)
    .execute();
}

export async function invalidateDevReplicaBase(message: string): Promise<void> {
  await setStepStatus('replica', 'stale', message);
}
