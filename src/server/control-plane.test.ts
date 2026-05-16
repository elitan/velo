import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { sql } from 'kysely';
import { createApiClient } from '../api/router';
import { closeDb, getDb } from '../db/client';
import { migrateDatabase } from '../db/migrate';
import {
  cancelJobById,
  createAuditJob,
  createJob,
  getActiveJob,
  getJob,
  listJobs,
  retryJobById,
  startJobWorker,
  type JobHandlers,
} from './services/job-service';
import { parseCreateBranchJobInput } from './services/job-handlers';
import { createBranchFromBase, replaceBranchWithReadyBranch, runExpiredBranchCleanup, updateBranchExpiry } from './services/branch-service';
import { parsePgBackRestInfo } from './services/backup-availability-service';
import { getBackupSettings, saveBackupSettings, setSetting } from './services/settings-service';
import { getControlPlaneState, invalidateDevReplicaBase, saveServer, setStepStatus } from './services/setup-state-service';
import { defaultCidrForHost, getProdAllowedCidr, normalizeAllowedCidr } from './services/prod-network-service';
import { buildReplicaBaseHealth, buildReplicaFreshness } from './services/replica-service';

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

  test('keeps state directory and sqlite files private', function testStatePermissions() {
    const databasePath = process.env.VELO_DB;
    if (!databasePath) {
      throw new Error('Missing VELO_DB');
    }

    expect(statMode(testDir)).toBe(0o700);
    expect(statMode(databasePath)).toBe(0o600);
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
      const log = db
        .query('select message from job_logs where job_id = (select id from jobs where type = ?)')
        .get('old-job') as { message: string } | null;
      db.close();

      expect(job).toMatchObject({
        type: 'old-job',
        attempts: 0,
        max_attempts: 1,
      });
      expect(job.run_after).toBeTruthy();
      expect(log?.message).toBe('old log');
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
    expect(state.replicaFreshness).toBe(null);
  });

  test('computes replica freshness lag and bytes', function testReplicaFreshness() {
    const freshness = buildReplicaFreshness(
      '0/3000000',
      '0/2000000',
      '2026-05-16T10:00:00.000Z',
      new Date('2026-05-16T10:00:03.000Z')
    );

    expect(freshness.lagMs).toBe(3000);
    expect(freshness.byteLag).toBe(16777216);
    expect(freshness.stale).toBe(false);
  });

  test('accepts healthy dev replica base signals', function testHealthyReplicaBaseSignals() {
    const health = buildReplicaBaseHealth({
      walReceiverStatus: 'streaming',
      initialReplayLsn: '0/2000000',
      currentReplayLsn: '0/3000000',
      replayPaused: false,
      replayedAt: '2026-05-16T10:00:00.000Z',
      replayTimelineId: 1,
      productionTimelineId: 1,
      slotRetainedWalBytes: 1024,
      now: new Date('2026-05-16T10:00:03.000Z'),
    });

    expect(health).toEqual({
      ok: true,
      errors: [],
      lagMs: 3000,
    });
  });

  test('reports broken dev replica base signals', function testBrokenReplicaBaseSignals() {
    const health = buildReplicaBaseHealth({
      walReceiverStatus: 'stopped',
      initialReplayLsn: '0/2000000',
      currentReplayLsn: '0/2000000',
      replayPaused: true,
      replayedAt: '2026-05-16T09:59:00.000Z',
      replayTimelineId: 2,
      productionTimelineId: 1,
      slotRetainedWalBytes: 2 * 1024 * 1024 * 1024,
      now: new Date('2026-05-16T10:00:00.000Z'),
    });

    expect(health.ok).toBe(false);
    expect(health.errors).toEqual([
      'WAL receiver is not streaming',
      'replay LSN is not advancing',
      'WAL replay is paused',
      'replica replay lag is too high',
      'replica timeline does not follow production',
      'replication slot retained WAL is too large',
    ]);
  });

  test('defaults prod allowed cidr to dev server ip', async function testProdAllowedCidrDefault() {
    await saveServer({
      role: 'dev',
      host: '157.180.22.136',
      sshUser: 'root',
      sshKeyPath: '/root/.ssh/frost-e2e-ci',
    });

    expect(await getProdAllowedCidr()).toBe('157.180.22.136/32');
    expect(defaultCidrForHost('2001:db8::1')).toBe('2001:db8::1/128');
  });

  test('saves prod allowed cidr override', async function testSaveProdAllowedCidr() {
    await saveServer({
      role: 'prod',
      host: '89.167.89.255',
      sshUser: 'root',
      sshKeyPath: '/root/.ssh/frost-e2e-ci',
      allowedCidr: '198.51.100.0/24',
    });

    const state = await getControlPlaneState();
    expect(state.prodAllowedCidr).toBe('198.51.100.0/24');
  });

  test('rejects invalid prod allowed cidr', function testInvalidProdAllowedCidr() {
    expect(function invalidNoPrefix() {
      normalizeAllowedCidr('0.0.0.0');
    }).toThrow('CIDR');
    expect(function invalidPrefix() {
      normalizeAllowedCidr('203.0.113.10/99');
    }).toThrow('between 0 and 32');
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

  test('blocks prod branch create when replica base is stale', async function testStaleReplicaBlocksBranch() {
    const message = 'Production was restored. Rebuild the dev replica before creating a branch';
    await invalidateDevReplicaBase(message);

    await expect(createBranchFromBase({ name: 'dev' })).rejects.toThrow(message);

    const replicaStep = await getDb()
      .selectFrom('setupSteps')
      .select(['status', 'message'])
      .where('key', '=', 'replica')
      .executeTakeFirstOrThrow();

    expect(replicaStep).toEqual({
      status: 'stale',
      message,
    });
  });

  test('rejects duplicate branch create requests before enqueue', async function testDuplicateBranchCreate() {
    const api = createApiClient();

    await api.branches.create({ name: 'dev' });
    await expect(api.branches.create({ name: 'dev' })).rejects.toThrow('Branch already exists: dev');

    const jobs = await listJobs(10);
    expect(jobs.filter(function isCreateJob(job) {
      return job.type === 'create-branch';
    })).toHaveLength(1);
  });

  test('rejects branch create when slug already exists', async function testExistingBranchCreate() {
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
        slug: 'dev',
        displayName: 'dev',
        dataset: 'velo_dev',
        status: 'running',
      })
      .execute();

    const api = createApiClient();
    await expect(api.branches.create({ name: 'dev' })).rejects.toThrow('Branch already exists: dev');
    expect(await listJobs(10)).toHaveLength(0);
  });

  test('requires typed confirmation before production restore enqueue', async function testProductionRestoreConfirmation() {
    const api = createApiClient();
    const restoreInput = {
      targetBranch: 'prod',
      sourceBranch: 'production',
      restoreTime: new Date().toISOString(),
    };

    await expect(api.branches.restore(restoreInput)).rejects.toThrow('Type restore production to restore production');
    expect(await listJobs(10)).toHaveLength(0);

    const job = await api.branches.restore({
      ...restoreInput,
      productionRestoreConfirmation: 'restore production',
    });
    const record = await getJob(job.id);

    expect(record.type).toBe('restore-branch');
    expect(record.input).toEqual(restoreInput);
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

  test('preserves branch ttl through queued create job input', async function testCreateBranchJobTtl() {
    const api = createApiClient();
    await api.branches.create({
      name: 'ttl-branch',
      parentBranchId: null,
      ttlHours: 1,
    });

    const jobs = await listJobs(10);
    const job = jobs.find(function isCreateBranchJob(record) {
      return record.type === 'create-branch';
    });
    const parsed = parseCreateBranchJobInput(job?.input);

    expect(parsed).toEqual({
      name: 'ttl-branch',
      parentBranchId: null,
      ttlHours: 1,
    });
  });

  test('promotes ready replacement without changing branch identity', async function testPromoteReadyReplacement() {
    const projectId = await createProject();
    const originalId = await createBranchRecord({
      projectId,
      slug: 'dev',
      displayName: 'dev',
      dataset: 'prod.dev',
      port: 41001,
      connectionUrl: 'postgresql://postgres:old@example.com:41001/postgres',
    });
    const replacementId = await createBranchRecord({
      projectId,
      slug: 'dev-tmp',
      displayName: 'dev',
      dataset: 'prod.dev_tmp',
      port: 41002,
      connectionUrl: 'postgresql://postgres:new@example.com:41002/postgres',
    });

    const result = await replaceBranchWithReadyBranch({
      targetBranchId: originalId,
      replacementBranchId: replacementId,
      cleanupReplacedBranch: async function cleanup(branch) {
        return [`cleaned ${branch.dataset}`];
      },
    });
    const branches = await getDb()
      .selectFrom('branches')
      .select(['id', 'slug', 'dataset', 'port', 'connectionUrl'])
      .orderBy('id')
      .execute();

    expect(result).toMatchObject({
      id: originalId,
      slug: 'dev',
      displayName: 'dev',
      connectionUrl: 'postgresql://postgres:new@example.com:41002/postgres',
      cleanupLogs: ['cleaned prod.dev'],
    });
    expect(branches).toEqual([{
      id: originalId,
      slug: 'dev',
      dataset: 'prod.dev_tmp',
      port: 41002,
      connectionUrl: 'postgresql://postgres:new@example.com:41002/postgres',
    }]);
  });

  test('keeps original branch when replacement promotion fails', async function testReplacementPromotionFailureKeepsOriginal() {
    const projectId = await createProject();
    const originalId = await createBranchRecord({
      projectId,
      slug: 'dev',
      displayName: 'dev',
      dataset: 'prod.dev',
      port: 41001,
      connectionUrl: 'postgresql://postgres:old@example.com:41001/postgres',
    });
    const replacementId = await createBranchRecord({
      projectId,
      slug: 'dev-tmp',
      displayName: 'dev',
      dataset: 'prod.dev_tmp',
      port: 41002,
      connectionUrl: 'postgresql://postgres:new@example.com:41002/postgres',
    });
    await createBranchRecord({
      projectId,
      slug: 'child',
      displayName: 'child',
      dataset: 'prod.child',
      parentBranchId: originalId,
    });
    const cleanedReplacementIds: number[] = [];

    await expect(replaceBranchWithReadyBranch({
      targetBranchId: originalId,
      replacementBranchId: replacementId,
      cleanupFailedReplacement: async function cleanupReplacement(branchId) {
        cleanedReplacementIds.push(branchId);
      },
    })).rejects.toThrow('Branch has child branches');

    const original = await getDb()
      .selectFrom('branches')
      .select(['id', 'slug', 'dataset', 'port', 'connectionUrl'])
      .where('id', '=', originalId)
      .executeTakeFirstOrThrow();

    expect(original).toEqual({
      id: originalId,
      slug: 'dev',
      dataset: 'prod.dev',
      port: 41001,
      connectionUrl: 'postgresql://postgres:old@example.com:41001/postgres',
    });
    expect(cleanedReplacementIds).toEqual([replacementId]);
  });

  test('keeps promoted branch when old resource cleanup fails', async function testReplacementCleanupFailure() {
    const projectId = await createProject();
    const originalId = await createBranchRecord({
      projectId,
      slug: 'dev',
      displayName: 'dev',
      dataset: 'prod.dev',
      port: 41001,
      connectionUrl: 'postgresql://postgres:old@example.com:41001/postgres',
    });
    const replacementId = await createBranchRecord({
      projectId,
      slug: 'dev-tmp',
      displayName: 'dev',
      dataset: 'prod.dev_tmp',
      port: 41002,
      connectionUrl: 'postgresql://postgres:new@example.com:41002/postgres',
    });

    const result = await replaceBranchWithReadyBranch({
      targetBranchId: originalId,
      replacementBranchId: replacementId,
      cleanupReplacedBranch: async function cleanup() {
        return ['replacement succeeded, but old resource cleanup failed: cleanup broke'];
      },
    });
    const promoted = await getDb()
      .selectFrom('branches')
      .select(['id', 'slug', 'dataset'])
      .where('id', '=', originalId)
      .executeTakeFirstOrThrow();

    expect(promoted).toEqual({
      id: originalId,
      slug: 'dev',
      dataset: 'prod.dev_tmp',
    });
    expect(result.cleanupLogs).toEqual(['replacement succeeded, but old resource cleanup failed: cleanup broke']);
  });
});

async function createProject(): Promise<number> {
  await getDb()
    .insertInto('projects')
    .values({
      name: 'prod',
      postgresVersion: '17',
      databaseName: 'postgres',
      appUser: 'postgres',
    })
    .execute();

  const project = await getDb()
    .selectFrom('projects')
    .select('id')
    .where('name', '=', 'prod')
    .executeTakeFirstOrThrow();

  return project.id;
}

async function createBranchRecord(input: {
  projectId: number;
  slug: string;
  displayName: string;
  dataset: string;
  parentBranchId?: number | null;
  port?: number | null;
  connectionUrl?: string | null;
}): Promise<number> {
  await getDb()
    .insertInto('branches')
    .values({
      projectId: input.projectId,
      slug: input.slug,
      displayName: input.displayName,
      dataset: input.dataset,
      status: 'running',
      parentBranchId: input.parentBranchId ?? null,
      port: input.port ?? null,
      connectionUrl: input.connectionUrl ?? null,
    })
    .execute();

  const branch = await getDb()
    .selectFrom('branches')
    .select('id')
    .where('slug', '=', input.slug)
    .executeTakeFirstOrThrow();

  return branch.id;
}

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

  const job = db.prepare('insert into jobs (type, status) values (?, ?)').run('old-job', 'running');
  db.prepare('insert into job_logs (job_id, level, message) values (?, ?, ?)').run(Number(job.lastInsertRowid), 'info', 'old log');
  db.close();
}

function statMode(path: string): number {
  return statSync(path).mode & 0o777;
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

  test('stores audit jobs without queueing work', async function testAuditJob() {
    const job = await createAuditJob('prod-write-attempt', {
      area: 'sql',
      allowed: false,
    }, 'blocked production sql write');

    const record = await getJob(job.id);
    expect(record.status).toBe('done');
    expect(record.attempts).toBe(1);
    expect(record.logs[0]?.message).toBe('blocked production sql write');
    expect(await getActiveJob('prod-write-attempt')).toBeUndefined();
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

  test('redacts job input returned to API callers', async function testRedactedJobInput() {
    const job = await createJob('test-job', {
      branch: 'preview-1',
      password: 'secret-value',
      connectionUrl: 'postgresql://postgres:bad@localhost:5432/postgres',
    });
    const record = await getJob(job.id);

    expect(JSON.stringify(record.input)).toContain('preview-1');
    expect(JSON.stringify(record.input)).not.toContain('secret-value');
    expect(JSON.stringify(record.input)).not.toContain('bad@localhost');
  });

  test('cancels queued jobs', async function testCancelQueuedJob() {
    const job = await createJob('create-branch', { name: 'preview-1' });
    const record = await cancelJobById(job.id);

    expect(record.status).toBe('cancelled');
    expect(record.error).toBe('cancelled by user');
    expect(record.canCancel).toBe(false);
  });

  test('requeues only safe failed jobs', async function testManualRetryRules() {
    const safe = await createJob('create-branch', { name: 'preview-1' });
    const unsafe = await createJob('restore-branch', {
      targetBranch: 'production',
      sourceBranch: 'production',
      restoreTime: new Date().toISOString(),
    });

    await getDb()
      .updateTable('jobs')
      .set({ status: 'error', error: 'failed' })
      .where('id', 'in', [safe.id, unsafe.id])
      .execute();

    const retried = await retryJobById(safe.id);

    expect(retried.status).toBe('queued');
    expect(retried.attempts).toBe(0);
    await expect(retryJobById(unsafe.id)).rejects.toThrow('Job cannot be retried');
  });

  test('links setup step errors to the running job', async function testSetupFailedJobLink() {
    const job = await createJob('setup-step-job');
    const worker = startTestWorker({
      'setup-step-job': async function handleJob() {
        await setStepStatus('prod-check', 'error', 'prod failed');
        throw new Error('prod failed');
      },
    });

    await worker.tick();
    await waitForJob(job.id);
    worker.stop();

    const state = await getControlPlaneState();
    const step = state.setupSteps.find(function findProdCheck(item) {
      return item.key === 'prod-check';
    });

    expect(step?.failedJobId).toBe(job.id);
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

    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
      return job;
    }

    await Bun.sleep(20);
  }

  throw new Error(`job ${jobId} did not finish`);
}
