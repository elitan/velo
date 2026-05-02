import { sql } from 'kysely';
import { getDb } from '../../db/client';
import type { Server } from '../../db/schema';
import { runCommand, runSshCommand } from './command-service';
import { listJobs, type JobRecord } from './job-service';
import { getBackupAvailability, type BackupAvailability } from './backup-availability-service';
import { getBackupSettings, getSetting, type BackupSettings } from './settings-service';

export interface ServerInput {
  role: 'prod' | 'dev';
  host: string;
  sshUser: string;
  sshKeyPath: string;
}

export interface DashboardState {
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
    name: string;
    status: string;
    port: number | null;
    connectionUrl: string | null;
    createdAt: string;
  }>;
  jobs: JobRecord[];
  backup: BackupSettings;
  backupAvailability: BackupAvailability;
  prodConnectionUrl: string | null;
}

export async function getDashboardState(): Promise<DashboardState> {
  const db = getDb();
  const [servers, setupSteps, branches, jobs, backup, backupAvailability, prodConnectionUrl] = await Promise.all([
    db.selectFrom('servers').selectAll().orderBy('role').execute(),
    db
      .selectFrom('setup_steps')
      .select(['key', 'label', 'status', 'message', 'updated_at as updatedAt'])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('branches')
      .select(['id', 'name', 'status', 'port', 'connection_url as connectionUrl', 'created_at as createdAt'])
      .where('name', 'not like', 'preview-%')
      .orderBy('created_at', 'desc')
      .execute(),
    listJobs(10),
    getBackupSettings(),
    getBackupAvailability(),
    getSetting('prod.connectionUrl'),
  ]);

  return { servers, setupSteps, branches, jobs, backup, backupAvailability, prodConnectionUrl };
}

export async function saveServer(input: ServerInput): Promise<Server> {
  const db = getDb();

  await db
    .insertInto('servers')
    .values({
      role: input.role,
      host: input.host,
      ssh_user: input.sshUser,
      ssh_key_path: input.sshKeyPath,
      status: 'unknown',
      status_message: null,
      last_checked_at: null,
    })
    .onConflict(function updateExisting(oc) {
      return oc.column('role').doUpdateSet({
        host: input.host,
        ssh_user: input.sshUser,
        ssh_key_path: input.sshKeyPath,
        status: 'unknown',
        status_message: null,
        updated_at: sql`datetime('now')`,
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
        user: server.ssh_user,
        keyPath: server.ssh_key_path,
      },
      'uname -srm && id -un && command -v sudo >/dev/null && echo sudo-ok'
    );

  const ok = result.exitCode === 0;
  const message = ok ? result.stdout : result.stderr || result.stdout || 'check failed';

  await db
    .updateTable('servers')
    .set({
      status: ok ? 'ok' : 'error',
      status_message: message,
      last_checked_at: new Date().toISOString(),
      updated_at: sql`datetime('now')`,
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
    .updateTable('setup_steps')
    .set({
      status,
      message,
      updated_at: sql`datetime('now')`,
    })
    .where('key', '=', key)
    .execute();
}
