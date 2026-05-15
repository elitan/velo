import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { sql } from 'kysely';
import { closeDb, getDb } from '../db/client';
import { migrateDatabase } from '../db/migrate';
import { createJob, getActiveJob, getJob, listJobs, startJobWorker, type JobHandlers } from './services/job-service';
import { createBranchFromBase, runExpiredBranchCleanup, updateBranchExpiry } from './services/branch-service';
import { parsePgBackRestInfo } from './services/backup-availability-service';
import { getBackupSettings, saveBackupSettings, setSetting } from './services/settings-service';
import { getControlPlaneState, saveServer } from './services/setup-state-service';

let testDir: string;

beforeEach(async function setupDatabase() {
  testDir = mkdtempSync(join(tmpdir(), 'velo-control-plane-'));
  process.env.VELO_DB = join(testDir, 'velo.sqlite');
  migrateDatabase();
});

afterEach(async function cleanupDatabase() {
  await closeDb();
  delete process.env.VELO_DB;
  rmSync(testDir, { recursive: true, force: true });
});

describe('control plane database', function controlPlaneDatabase() {
  test('uses real pgBackRest backup history for restore windows', function testBackupAvailability() {
    const availability = parsePgBackRestInfo(JSON.stringify([{
      name: 'main',
      status: { code: 0, message: 'ok' },
      archive: [{ id: '16-1', min: '000000010000000000000001', max: '000000010000000000000002' }],
      backup: [
        {
          label: '20260430-193902F',
          type: 'full',
          error: false,
          timestamp: { start: 1777577942, stop: 1777578095 },
        },
        {
          label: '20260502-021502F',
          type: 'full',
          error: false,
          timestamp: { start: 1777688102, stop: 1777688267 },
        },
      ],
    }]), 90, new Date('2026-05-02T12:00:00.000Z'));

    expect(availability.status).toBe('ok');
    expect(availability.pitr.from).toBe('2026-04-30T19:39:02.000Z');
    expect(availability.pitr.to).toBe('2026-05-02T12:00:00.000Z');
    expect(availability.backups.map(function mapBackup(backup) {
      return backup.label;
    })).toEqual(['20260502-021502F', '20260430-193902F']);
  });

  test('migrates idempotently and creates setup steps', async function testMigrations() {
    migrateDatabase();

    const steps = await getDb()
      .selectFrom('setupSteps')
      .select(['key', 'status'])
      .orderBy('id')
      .execute();

    expect(steps.map(function mapStep(step) {
      return step.key;
    })).toEqual([
      'dev-check',
      'prod-check',
      'prod-setup',
      'backups',
      'replica',
    ]);
    expect(steps.every(function isPending(step) {
      return step.status === 'pending';
    })).toBe(true);
  });

  test('migrates job queue columns on existing databases', async function testExistingJobMigration() {
    const originalDb = process.env.VELO_DB;
    const existingDir = mkdtempSync(join(tmpdir(), 'velo-existing-jobs-'));
    const existingDbPath = join(existingDir, 'velo.sqlite');

    await closeDb();

    try {
      createPreQueueDatabase(existingDbPath);
      process.env.VELO_DB = existingDbPath;
      migrateDatabase();

      const db = new Database(existingDbPath);
      const job = db
        .query('select type, attempts, max_attempts, run_after from jobs where type = ?')
        .get('old-job') as { type: string; attempts: number; max_attempts: number; run_after: string | null };
      db.close();

      expect(job).toMatchObject({
        type: 'old-job',
        attempts: 0,
        max_attempts: 1,
      });
      expect(job.run_after).toBeTruthy();
    } finally {
      await closeDb();
      process.env.VELO_DB = originalDb;
      rmSync(existingDir, { recursive: true, force: true });
    }
  });

  test('returns dashboard state without leaking backup secrets', async function testControlPlaneState() {
    await saveServer({
      role: 'dev',
      host: '157.180.22.136',
      sshUser: 'root',
      sshKeyPath: '/root/.ssh/frost-e2e-ci',
    });
    await saveBackupSettings({
      enabled: true,
      endpoint: 'https://account.r2.cloudflarestorage.com',
      bucket: 'velo-dev',
      region: 'auto',
      accessKeyId: 'access-key',
      secretAccessKey: 'super-secret',
      path: 'prod',
    });
    await setSetting('prod.connectionUrl', 'postgresql://postgres:secret@example.com:5432/postgres');

    const state = await getControlPlaneState();

    expect(state.servers).toHaveLength(1);
    expect(state.backup).toEqual({
      enabled: true,
      endpoint: 'https://account.r2.cloudflarestorage.com',
      bucket: 'velo-dev',
      region: 'auto',
      accessKeyId: 'access-key',
      secretConfigured: true,
      path: '/prod',
      pitrDays: 7,
      fullBackupRetentionDays: 90,
    });
    expect(JSON.stringify(state)).not.toContain('super-secret');
    expect(state.prodConnectionUrl).toBe('postgresql://postgres:secret@example.com:5432/postgres');
  });

  test('keeps existing backup secret when saving without a new one', async function testKeepBackupSecret() {
    await saveBackupSettings({
      enabled: true,
      endpoint: 'https://old.example.com',
      bucket: 'old',
      region: 'auto',
      accessKeyId: 'old-access',
      secretAccessKey: 'keep-me',
      path: '/old',
    });
    await saveBackupSettings({
      enabled: true,
      endpoint: 'https://new.example.com',
      bucket: 'new',
      region: 'auto',
      accessKeyId: 'new-access',
      secretAccessKey: '',
      path: '/new',
    });

    const backup = await getBackupSettings();
    const secret = await getDb()
      .selectFrom('settings')
      .select('value')
      .where('key', '=', 'backup.s3.secretAccessKey')
      .executeTakeFirstOrThrow();

    expect(backup.endpoint).toBe('https://new.example.com');
    expect(backup.secretConfigured).toBe(true);
    expect(secret.value).toBe('keep-me');
  });

  test('blocks first branch before replica base is ready', async function testBranchNeedsReplica() {
    await expect(createBranchFromBase({ name: 'dev' })).rejects.toThrow('Create the dev replica before creating a branch');

    const firstBranchStep = await getDb()
      .selectFrom('setupSteps')
      .select(['status'])
      .where('key', '=', 'first-branch')
      .executeTakeFirst();

    expect(firstBranchStep).toBeUndefined();
  });

  test('tracks branch expiry and skips active cleanup targets', async function testBranchExpiry() {
    const db = getDb();
    await db
      .insertInto('projects')
      .values({
        name: 'prod',
        postgresVersion: '17',
        databaseName: 'postgres',
        appUser: 'postgres',
      })
      .execute();
    const project = await db
      .selectFrom('projects')
      .select('id')
      .where('name', '=', 'prod')
      .executeTakeFirstOrThrow();

    await db
      .insertInto('branches')
      .values({
        projectId: project.id,
        slug: 'preview-1',
        displayName: 'preview-1',
        dataset: 'prod_preview_1',
        status: 'running',
        expiresAt: '2026-05-01T00:00:00.000Z',
      })
      .execute();

    const branch = await db
      .selectFrom('branches')
      .select(['id'])
      .where('slug', '=', 'preview-1')
      .executeTakeFirstOrThrow();
    const activeJob = await createJob('reset-branch', { id: branch.id });

    await updateBranchExpiry({ id: branch.id, expiresAt: '2026-05-02T00:00:00.000Z' });
    await runExpiredBranchCleanup();

    const updated = await db
      .selectFrom('branches')
      .select(['expiresAt'])
      .where('id', '=', branch.id)
      .executeTakeFirstOrThrow();
    const cleanupJob = await getActiveJob('branch-cleanup');

    expect(activeJob.status).toBe('queued');
    expect(updated.expiresAt).toBe('2026-05-02T00:00:00.000Z');
    expect(cleanupJob).toBeUndefined();
  });
});

function createPreQueueDatabase(databasePath: string): void {
  const db = new Database(databasePath);
  db.exec(`
    create table schema_migrations (
      id text primary key,
      applied_at text not null default (datetime('now'))
    );
  `);

  for (const id of ['001_initial', '002_jobs', '003_branch_parent', '004_branch_identity']) {
    db.exec(readFileSync(join(process.cwd(), 'src/db/migrations', `${id}.sql`), 'utf8'));
    db.prepare('insert into schema_migrations (id) values (?)').run(id);
  }

  db.prepare('insert into jobs (type, status) values (?, ?)').run('old-job', 'running');
  db.close();
}

describe('control plane jobs', function controlPlaneJobs() {
  test('runs jobs, stores logs, and sanitizes secrets', async function testSuccessfulJob() {
    const job = await createJob('test-job', { branch: 'preview-1' });
    const worker = startTestWorker({
      'test-job': async function handleJob(_input, context) {
        await context.log('using password=secret-value and secret access key abc');
      },
    });

    await worker.tick();
    const record = await waitForJob(job.id);
    worker.stop();

    expect(record.status).toBe('done');
    expect(record.logs.some(function hasSanitizedLog(log) {
      return log.message.includes('password=***');
    })).toBe(true);
    expect(JSON.stringify(record)).not.toContain('secret-value');
    expect(JSON.stringify(record)).not.toContain('abc');
  });

  test('stores sanitized job failures', async function testFailedJob() {
    const job = await createJob('failing-job');
    const worker = startTestWorker({
      'failing-job': async function handleJob() {
        throw new Error('failed with access key id abc123 and password=bad');
      },
    });

    await worker.tick();
    const record = await waitForJob(job.id);
    const jobs = await listJobs();
    worker.stop();

    expect(record.status).toBe('error');
    expect(record.error).toContain('access_key_id=***');
    expect(record.error).toContain('password=***');
    expect(jobs[0]?.id).toBe(job.id);
  });

  test('finds only queued or running jobs by type', async function testActiveJob() {
    const finished = await createJob('prod-bootstrap');
    const worker = startTestWorker({
      'prod-bootstrap': async function handleJob() {},
    });
    await worker.tick();
    await waitForJob(finished.id);
    worker.stop();

    const active = await createJob('prod-bootstrap');
    const ignored = await createJob('dev-bootstrap');

    expect(await getActiveJob('prod-bootstrap')).toMatchObject({ id: active.id });
    expect(await getActiveJob('dev-bootstrap')).toMatchObject({ id: ignored.id });
    expect(await getActiveJob('missing-job')).toBeUndefined();
  });

  test('retries failed jobs with backoff', async function testRetryJob() {
    const job = await createJob('retry-job', undefined, { maxAttempts: 2 });
    let runs = 0;
    const worker = startTestWorker({
      'retry-job': async function handleJob() {
        runs += 1;

        if (runs === 1) {
          throw new Error('ssh failed');
        }
      },
    });

    await worker.tick();
    const queued = await getJob(job.id);

    expect(queued.status).toBe('queued');
    expect(queued.attempts).toBe(1);
    expect(queued.error).toBe('ssh failed');
    expect(queued.logs.some(function hasRetryLog(log) {
      return log.message.includes('retrying retry-job');
    })).toBe(true);

    await getDb()
      .updateTable('jobs')
      .set({ runAfter: sql<string>`datetime('now')` })
      .where('id', '=', job.id)
      .execute();

    await worker.tick();
    const done = await waitForJob(job.id);
    worker.stop();

    expect(done.status).toBe('done');
    expect(done.attempts).toBe(2);
  });

  test('recovers stale running jobs', async function testRecoverStaleJob() {
    const job = await createJob('stale-job', undefined, { maxAttempts: 2 });
    const worker = startTestWorker({
      'stale-job': async function handleJob(_input, context) {
        await context.log('recovered');
      },
    });

    await markRunningStale(job.id, 1);
    await worker.tick();
    const record = await waitForJob(job.id);
    worker.stop();

    expect(record.status).toBe('done');
    expect(record.attempts).toBe(2);
    expect(record.logs.some(function hasLostHeartbeatLog(log) {
      return log.message.includes('lost heartbeat');
    })).toBe(true);
  });

  test('marks exhausted stale jobs as error', async function testExhaustedStaleJob() {
    const job = await createJob('stale-job', undefined, { maxAttempts: 1 });
    const worker = startTestWorker({
      'stale-job': async function handleJob() {},
    });

    await markRunningStale(job.id, 1);
    await worker.tick();
    const record = await waitForJob(job.id);
    worker.stop();

    expect(record.status).toBe('error');
    expect(record.error).toContain('lost heartbeat');
  });

  test('does not let duplicate workers claim the same job', async function testDuplicateWorkerClaim() {
    const job = await createJob('slow-job', undefined, { maxAttempts: 1 });
    let runs = 0;
    const handlers: JobHandlers = {
      'slow-job': async function handleJob() {
        runs += 1;
        await Bun.sleep(50);
      },
    };
    const firstWorker = startTestWorker(handlers, 'first-worker');
    const secondWorker = startTestWorker(handlers, 'second-worker');

    await Promise.all([
      firstWorker.tick(),
      secondWorker.tick(),
    ]);
    const record = await waitForJob(job.id);
    firstWorker.stop();
    secondWorker.stop();

    expect(record.status).toBe('done');
    expect(runs).toBe(1);
  });
});

function startTestWorker(handlers: JobHandlers, workerId = 'test-worker') {
  return startJobWorker(handlers, {
    autoStart: false,
    staleTimeoutSeconds: 1,
    workerId,
  });
}

async function markRunningStale(jobId: number, attempts: number): Promise<void> {
  await getDb()
    .updateTable('jobs')
    .set({
      status: 'running',
      attempts,
      lockedAt: sql<string>`datetime('now', '-10 seconds')`,
      lockedBy: 'dead-worker',
      heartbeatAt: sql<string>`datetime('now', '-10 seconds')`,
      updatedAt: sql<string>`datetime('now', '-10 seconds')`,
    })
    .where('id', '=', jobId)
    .execute();
}

async function waitForJob(jobId: number) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 2000) {
    const job = await getJob(jobId);

    if (job.status === 'done' || job.status === 'error') {
      return job;
    }

    await Bun.sleep(20);
  }

  throw new Error(`job ${jobId} did not finish`);
}
