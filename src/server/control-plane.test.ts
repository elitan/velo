import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../db/client';
import { migrateDatabase } from '../db/migrate';
import { createJob, getActiveJob, getJob, listJobs, runJob } from './services/job-service';
import { createBranchFromBase } from './services/branch-service';
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
      'first-branch',
    ]);
    expect(steps.every(function isPending(step) {
      return step.status === 'pending';
    })).toBe(true);
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
      .executeTakeFirstOrThrow();

    expect(firstBranchStep.status).toBe('pending');
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

  test('finds only queued or running jobs by type', async function testActiveJob() {
    const finished = await createJob('prod-bootstrap');
    runJob(finished, async function handleJob() {});
    await waitForJob(finished.id);

    const active = await createJob('prod-bootstrap');
    const ignored = await createJob('dev-bootstrap');

    expect(await getActiveJob('prod-bootstrap')).toMatchObject({ id: active.id });
    expect(await getActiveJob('dev-bootstrap')).toMatchObject({ id: ignored.id });
    expect(await getActiveJob('missing-job')).toBeUndefined();
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
