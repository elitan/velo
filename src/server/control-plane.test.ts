import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../db/client';
import { migrateDatabase } from '../db/migrate';
import { createJob, getJob, listJobs, runJob } from './services/job-service';
import { getBackupSettings, saveBackupSettings, setSetting } from './services/settings-service';
import { getDashboardState, saveServer } from './services/setup-state-service';

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
  test('migrates idempotently and creates setup steps', async function testMigrations() {
    migrateDatabase();

    const steps = await getDb()
      .selectFrom('setup_steps')
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
      'first-branch',
    ]);
    expect(steps.every(function isPending(step) {
      return step.status === 'pending';
    })).toBe(true);
  });

  test('returns dashboard state without leaking backup secrets', async function testDashboardState() {
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

    const state = await getDashboardState();

    expect(state.servers).toHaveLength(1);
    expect(state.backup).toEqual({
      enabled: true,
      endpoint: 'https://account.r2.cloudflarestorage.com',
      bucket: 'velo-dev',
      region: 'auto',
      accessKeyId: 'access-key',
      secretConfigured: true,
      path: '/prod',
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
});

describe('control plane jobs', function controlPlaneJobs() {
  test('runs jobs, stores logs, and sanitizes secrets', async function testSuccessfulJob() {
    const job = await createJob('test-job', { branch: 'preview-1' });

    runJob(job, async function handleJob(context) {
      await context.log('using password=secret-value and secret access key abc');
    });

    const record = await waitForJob(job.id);

    expect(record.status).toBe('done');
    expect(record.logs.some(function hasSanitizedLog(log) {
      return log.message.includes('password=***');
    })).toBe(true);
    expect(JSON.stringify(record)).not.toContain('secret-value');
    expect(JSON.stringify(record)).not.toContain('abc');
  });

  test('stores sanitized job failures', async function testFailedJob() {
    const job = await createJob('failing-job');

    runJob(job, async function handleJob() {
      throw new Error('failed with access key id abc123 and password=bad');
    });

    const record = await waitForJob(job.id);
    const jobs = await listJobs();

    expect(record.status).toBe('error');
    expect(record.error).toContain('access_key_id=***');
    expect(record.error).toContain('password=***');
    expect(jobs[0]?.id).toBe(job.id);
  });
});

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
