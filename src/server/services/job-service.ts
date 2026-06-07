import { sql } from 'kysely';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getDb } from '../../db/client';
import type { Job, JobLog } from '../../db/schema';

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
export type JobHandler = (input: unknown, context: JobContext) => Promise<void>;
export type JobHandlers = Record<string, JobHandler>;

const DEFAULT_STALE_TIMEOUT_SECONDS = 5 * 60;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const SAFE_MANUAL_RETRY_JOB_TYPES = [
  'dev-bootstrap',
  'prod-bootstrap',
  'backup-reconfigure',
  'setup',
  'replica-base',
  'create-branch',
  'delete-branch',
  'branch-cleanup',
];
const AUTO_RETRY_JOB_TYPES = [
  ...SAFE_MANUAL_RETRY_JOB_TYPES,
  'restore-branch',
];
const currentJobId = new AsyncLocalStorage<number>();

export interface JobRecord {
  id: number;
  type: string;
  status: JobStatus;
  input: unknown;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  runAfter: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  durationMs: number | null;
  canRetry: boolean;
  canCancel: boolean;
  logs: Array<{
    id: number;
    level: 'info' | 'error';
    message: string;
    createdAt: string;
  }>;
}

export interface JobContext {
  jobId: number;
  attempt: number;
  log(message: string): Promise<void>;
  disableRetry(): void;
}

export interface CreateJobOptions {
  maxAttempts?: number;
}

export interface ListJobsOptions {
  offset?: number;
  status?: JobStatus;
  type?: string;
}

export interface JobWorker {
  tick(): Promise<void>;
  stop(): void;
}

export interface StartJobWorkerOptions {
  pollIntervalMs?: number;
  staleTimeoutSeconds?: number;
  workerId?: string;
  autoStart?: boolean;
}

export async function createJob(type: string, input?: unknown, options: CreateJobOptions = {}): Promise<Job> {
  return getDb()
    .insertInto('jobs')
    .values({
      type,
      status: 'queued',
      inputJson: input === undefined ? null : JSON.stringify(input),
      error: null,
      attempts: 0,
      maxAttempts: options.maxAttempts ?? getDefaultMaxAttempts(type, input),
      runAfter: sql<string>`datetime('now')`,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function getCurrentJobId(): number | null {
  return currentJobId.getStore() ?? null;
}

export function startJobWorker(handlers: JobHandlers, options: StartJobWorkerOptions = {}): JobWorker {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleTimeoutSeconds = options.staleTimeoutSeconds ?? DEFAULT_STALE_TIMEOUT_SECONDS;
  const workerId = options.workerId ?? `worker-${process.pid}-${Math.random().toString(36).slice(2)}`;
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    if (running || stopped) {
      return;
    }

    running = true;

    try {
      await recoverStaleJobs(staleTimeoutSeconds);
      const job = await claimNextJob(workerId);

      if (job) {
        await runClaimedJob(job, handlers, workerId, staleTimeoutSeconds);
      }
    } finally {
      running = false;
    }
  }

  function stop(): void {
    stopped = true;

    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  if (options.autoStart !== false) {
    void tick();
    timer = setInterval(function runWorkerTick() {
      void tick();
    }, pollIntervalMs);
    (timer as { unref?: () => void }).unref?.();
  }

  return { tick, stop };
}

export async function listJobs(limit = 20, options: ListJobsOptions = {}): Promise<JobRecord[]> {
  let query = getDb()
    .selectFrom('jobs')
    .selectAll()
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .offset(options.offset ?? 0);

  if (options.status) {
    query = query.where('status', '=', options.status);
  }

  if (options.type) {
    query = query.where('type', '=', options.type);
  }

  const jobs = await query.execute();

  const result: JobRecord[] = [];

  for (const job of jobs) {
    const logs = await getJobLogs(job.id, 8);
    result.push(mapJob(job, logs));
  }

  return result;
}

export async function getJob(jobId: number): Promise<JobRecord> {
  const job = await getDb()
    .selectFrom('jobs')
    .selectAll()
    .where('id', '=', jobId)
    .executeTakeFirstOrThrow();
  const logs = await getJobLogs(job.id, 100);

  return mapJob(job, logs);
}

export async function retryJobById(jobId: number): Promise<JobRecord> {
  const job = await getDb()
    .selectFrom('jobs')
    .selectAll()
    .where('id', '=', jobId)
    .executeTakeFirstOrThrow();

  if (!canRetryJob(job)) {
    throw new Error(`Job cannot be retried: ${job.type}`);
  }

  await appendJobLog(job.id, 'info', `queued retry for ${job.type}`);
  await getDb()
    .updateTable('jobs')
    .set({
      status: 'queued',
      error: null,
      attempts: 0,
      runAfter: sql<string>`datetime('now')`,
      lockedAt: null,
      lockedBy: null,
      heartbeatAt: null,
      startedAt: null,
      finishedAt: null,
      updatedAt: sql<string>`datetime('now')`,
    })
    .where('id', '=', job.id)
    .where('status', '=', 'error')
    .execute();

  return getJob(job.id);
}

export async function cancelJobById(jobId: number): Promise<JobRecord> {
  const job = await getDb()
    .selectFrom('jobs')
    .selectAll()
    .where('id', '=', jobId)
    .executeTakeFirstOrThrow();

  if (job.status !== 'queued') {
    throw new Error('Only queued jobs can be cancelled');
  }

  await appendJobLog(job.id, 'info', `cancelled ${job.type}`);
  await getDb()
    .updateTable('jobs')
    .set({
      status: 'cancelled',
      error: 'cancelled by user',
      runAfter: null,
      lockedAt: null,
      lockedBy: null,
      heartbeatAt: null,
      finishedAt: sql<string>`datetime('now')`,
      updatedAt: sql<string>`datetime('now')`,
    })
    .where('id', '=', job.id)
    .where('status', '=', 'queued')
    .execute();

  return getJob(job.id);
}

export async function getActiveJob(type: string): Promise<Job | undefined> {
  return getDb()
    .selectFrom('jobs')
    .selectAll()
    .where('type', '=', type)
    .where('status', 'in', ['queued', 'running'])
    .orderBy('id', 'desc')
    .executeTakeFirst();
}

export async function getActiveJobs(): Promise<Job[]> {
  return getDb()
    .selectFrom('jobs')
    .selectAll()
    .where('status', 'in', ['queued', 'running'])
    .orderBy('id', 'desc')
    .execute();
}

async function claimNextJob(workerId: string): Promise<Job | undefined> {
  return getDb()
    .updateTable('jobs')
    .set({
      status: 'running',
      attempts: sql<number>`attempts + 1`,
      error: null,
      lockedAt: sql<string>`datetime('now')`,
      lockedBy: workerId,
      heartbeatAt: sql<string>`datetime('now')`,
      startedAt: sql<string>`datetime('now')`,
      finishedAt: null,
      updatedAt: sql<string>`datetime('now')`,
    })
    .where('id', '=', function selectNextQueuedJob(eb) {
      return eb
        .selectFrom('jobs')
        .select('id')
        .where('status', '=', 'queued')
        .where('runAfter', '<=', sql<string>`datetime('now')`)
        .orderBy('id')
        .limit(1);
    })
    .where('status', '=', 'queued')
    .returningAll()
    .executeTakeFirst();
}

async function runClaimedJob(
  job: Job,
  handlers: JobHandlers,
  workerId: string,
  staleTimeoutSeconds: number
): Promise<void> {
  let retryEnabled = true;
  const heartbeatMs = Math.max(1000, Math.floor(staleTimeoutSeconds * 500));
  const heartbeat = setInterval(function updateHeartbeat() {
    void touchJobHeartbeat(job.id, workerId);
  }, heartbeatMs);
  (heartbeat as { unref?: () => void }).unref?.();

  const context: JobContext = {
    jobId: job.id,
    attempt: job.attempts,
    async log(message: string) {
      await appendJobLog(job.id, 'info', message);
    },
    disableRetry() {
      retryEnabled = false;
    },
  };

  try {
    const handler = handlers[job.type];

    if (!handler) {
      throw new Error(`No job handler registered for ${job.type}`);
    }

    await appendJobLog(job.id, 'info', `attempt ${job.attempts} started ${job.type}`);
    await currentJobId.run(job.id, async function runJobWithContext() {
      await handler(parseJobInput(job), context);
    });
    await appendJobLog(job.id, 'info', `attempt ${job.attempts} finished ${job.type}`);
    await finishJob(job.id, workerId);
  } catch (error: any) {
    const message = sanitizeLogMessage(error?.message || String(error));
    await appendJobLog(job.id, 'error', message);

    if (retryEnabled && job.attempts < job.maxAttempts) {
      const backoffSeconds = getBackoffSeconds(job.attempts);
      await appendJobLog(job.id, 'info', `retrying ${job.type} in ${backoffSeconds}s`);
      await retryJob(job.id, message, backoffSeconds, workerId);
      return;
    }

    await errorJob(job.id, message, workerId);
  } finally {
    clearInterval(heartbeat);
  }
}

async function recoverStaleJobs(staleTimeoutSeconds: number): Promise<void> {
  const staleBefore = sql<string>`datetime('now', ${`-${staleTimeoutSeconds} seconds`})`;
  const staleJobs = await getDb()
    .selectFrom('jobs')
    .selectAll()
    .where('status', '=', 'running')
    .where(function findStaleJobs(eb) {
      return eb.or([
        eb('heartbeatAt', 'is', null),
        eb('heartbeatAt', '<', staleBefore),
      ]);
    })
    .execute();

  for (const job of staleJobs) {
    if (job.attempts < job.maxAttempts) {
      await appendJobLog(job.id, 'error', `attempt ${job.attempts} lost heartbeat`);
      await getDb()
        .updateTable('jobs')
        .set({
          status: 'queued',
          runAfter: sql<string>`datetime('now')`,
          lockedAt: null,
          lockedBy: null,
          heartbeatAt: null,
          updatedAt: sql<string>`datetime('now')`,
        })
        .where('id', '=', job.id)
        .where('status', '=', 'running')
        .execute();
      continue;
    }

    const message = `attempt ${job.attempts} lost heartbeat`;
    await appendJobLog(job.id, 'error', message);
    await errorJob(job.id, message);
  }
}

async function touchJobHeartbeat(jobId: number, workerId: string): Promise<void> {
  await getDb()
    .updateTable('jobs')
    .set({
      heartbeatAt: sql<string>`datetime('now')`,
      updatedAt: sql<string>`datetime('now')`,
    })
    .where('id', '=', jobId)
    .where('status', '=', 'running')
    .where('lockedBy', '=', workerId)
    .execute();
}

async function finishJob(jobId: number, workerId: string): Promise<void> {
  await getDb()
    .updateTable('jobs')
    .set({
      status: 'done',
      error: null,
      lockedAt: null,
      lockedBy: null,
      heartbeatAt: null,
      finishedAt: sql<string>`datetime('now')`,
      updatedAt: sql<string>`datetime('now')`,
    })
    .where('id', '=', jobId)
    .where('status', '=', 'running')
    .where('lockedBy', '=', workerId)
    .execute();
}

async function retryJob(jobId: number, error: string, backoffSeconds: number, workerId: string): Promise<void> {
  await getDb()
    .updateTable('jobs')
    .set({
      status: 'queued',
      error,
      runAfter: sql<string>`datetime('now', ${`+${backoffSeconds} seconds`})`,
      lockedAt: null,
      lockedBy: null,
      heartbeatAt: null,
      finishedAt: null,
      updatedAt: sql<string>`datetime('now')`,
    })
    .where('id', '=', jobId)
    .where('status', '=', 'running')
    .where('lockedBy', '=', workerId)
    .execute();
}

async function errorJob(jobId: number, error: string, workerId?: string): Promise<void> {
  let query = getDb()
    .updateTable('jobs')
    .set({
      status: 'error',
      error,
      lockedAt: null,
      lockedBy: null,
      heartbeatAt: null,
      finishedAt: sql<string>`datetime('now')`,
      updatedAt: sql<string>`datetime('now')`,
    })
    .where('id', '=', jobId);

  if (workerId) {
    query = query
      .where('status', '=', 'running')
      .where('lockedBy', '=', workerId);
  }

  await query.execute();
}

export async function appendJobLog(jobId: number, level: 'info' | 'error', message: string): Promise<void> {
  await getDb()
    .insertInto('jobLogs')
    .values({
      jobId: jobId,
      level,
      message: sanitizeLogMessage(message),
    })
    .execute();
}

async function getJobLogs(jobId: number, limit: number): Promise<JobLog[]> {
  return getDb()
    .selectFrom('jobLogs')
    .selectAll()
    .where('jobId', '=', jobId)
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
}

function mapJob(job: Job, logs: JobLog[]): JobRecord {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    input: redactValue(parseJobInput(job)),
    error: job.error,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    runAfter: job.runAfter,
    lockedAt: job.lockedAt,
    lockedBy: job.lockedBy,
    heartbeatAt: job.heartbeatAt,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    updatedAt: job.updatedAt,
    durationMs: getJobDurationMs(job),
    canRetry: canRetryJob(job),
    canCancel: job.status === 'queued',
    logs: logs.map(function mapLog(log) {
      return {
        id: log.id,
        level: log.level,
        message: log.message,
        createdAt: log.createdAt,
      };
    }),
  };
}

function parseJobInput(job: Job): unknown {
  if (job.inputJson === null) {
    return undefined;
  }

  return JSON.parse(job.inputJson);
}

function getDefaultMaxAttempts(type: string, input: unknown): number {
  if (type === 'restore-branch' && isProductionRestore(input)) {
    return 1;
  }

  if (AUTO_RETRY_JOB_TYPES.includes(type)) {
    return 3;
  }

  return 1;
}

function canRetryJob(job: Job): boolean {
  return job.status === 'error' && isSafeRetryJobType(job.type);
}

function isSafeRetryJobType(type: string): boolean {
  return SAFE_MANUAL_RETRY_JOB_TYPES.includes(type);
}

function getJobDurationMs(job: Job): number | null {
  const startedAt = job.startedAt ? new Date(job.startedAt).getTime() : null;

  if (!startedAt || Number.isNaN(startedAt)) {
    return null;
  }

  const finishedAt = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now();

  if (Number.isNaN(finishedAt)) {
    return null;
  }

  return Math.max(0, finishedAt - startedAt);
}

function isProductionRestore(input: unknown): boolean {
  return typeof input === 'object'
    && input !== null
    && 'targetBranch' in input
    && isProductionBranch(String(input.targetBranch));
}

function isProductionBranch(branch: string): boolean {
  const normalized = branch.trim().toLowerCase();
  return normalized === 'production' || normalized === 'prod';
}

function getBackoffSeconds(attempt: number): number {
  return Math.min(60, 5 * (2 ** Math.max(0, attempt - 1)));
}

function sanitizeLogMessage(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/([^:\s/]+):([^@\s]+)@/gi, 'postgresql://$1:***@')
    .replace(/password=[^ '\n]+/gi, 'password=***')
    .replace(/secret[ _-]?access[ _-]?key(?:\s*[=:]?\s*[^ '\n]+)?/gi, 'secret_access_key=***')
    .replace(/access[ _-]?key[ _-]?id(?:\s*[=:]?\s*[^ '\n]+)?/gi, 'access_key_id=***')
    .slice(0, 4000);
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeLogMessage(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactValue);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const redacted: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key) ? '***' : redactValue(item);
  }

  return redacted;
}

function isSensitiveKey(key: string): boolean {
  return /password|secret|token|accessKey|access_key|connectionUrl|sshKeyPath/i.test(key);
}
