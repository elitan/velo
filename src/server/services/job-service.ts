import { sql } from 'kysely';
import { getDb } from '../../db/client';
import type { Job, JobLog } from '../../db/schema';

export type JobStatus = 'queued' | 'running' | 'done' | 'error';

export interface JobRecord {
  id: number;
  type: string;
  status: JobStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  logs: Array<{
    id: number;
    level: 'info' | 'error';
    message: string;
    createdAt: string;
  }>;
}

export interface JobContext {
  jobId: number;
  log(message: string): Promise<void>;
}

export async function createJob(type: string, input?: unknown): Promise<Job> {
  await getDb()
    .insertInto('jobs')
    .values({
      type,
      status: 'queued',
      input_json: input === undefined ? null : JSON.stringify(input),
      error: null,
    })
    .execute();

  return getDb()
    .selectFrom('jobs')
    .selectAll()
    .orderBy('id', 'desc')
    .executeTakeFirstOrThrow();
}

export function runJob(job: Job, handler: (context: JobContext) => Promise<void>): void {
  void runJobInternal(job, handler);
}

export async function listJobs(limit = 20): Promise<JobRecord[]> {
  const jobs = await getDb()
    .selectFrom('jobs')
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();

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

export async function getActiveJob(type: string): Promise<Job | undefined> {
  return getDb()
    .selectFrom('jobs')
    .selectAll()
    .where('type', '=', type)
    .where('status', 'in', ['queued', 'running'])
    .orderBy('id', 'desc')
    .executeTakeFirst();
}

async function runJobInternal(job: Job, handler: (context: JobContext) => Promise<void>): Promise<void> {
  await updateJob(job.id, 'running', null, {
    startedAt: new Date().toISOString(),
  });
  await appendJobLog(job.id, 'info', `started ${job.type}`);

  const context: JobContext = {
    jobId: job.id,
    async log(message: string) {
      await appendJobLog(job.id, 'info', message);
    },
  };

  try {
    await handler(context);
    await appendJobLog(job.id, 'info', `finished ${job.type}`);
    await updateJob(job.id, 'done', null, {
      finishedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    const message = sanitizeLogMessage(error?.message || String(error));
    await appendJobLog(job.id, 'error', message);
    await updateJob(job.id, 'error', message, {
      finishedAt: new Date().toISOString(),
    });
  }
}

async function updateJob(
  jobId: number,
  status: JobStatus,
  error: string | null,
  options: { startedAt?: string; finishedAt?: string } = {}
): Promise<void> {
  await getDb()
    .updateTable('jobs')
    .set({
      status,
      error,
      started_at: options.startedAt,
      finished_at: options.finishedAt,
      updated_at: sql`datetime('now')`,
    })
    .where('id', '=', jobId)
    .execute();
}

export async function appendJobLog(jobId: number, level: 'info' | 'error', message: string): Promise<void> {
  await getDb()
    .insertInto('job_logs')
    .values({
      job_id: jobId,
      level,
      message: sanitizeLogMessage(message),
    })
    .execute();
}

async function getJobLogs(jobId: number, limit: number): Promise<JobLog[]> {
  return getDb()
    .selectFrom('job_logs')
    .selectAll()
    .where('job_id', '=', jobId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
}

function mapJob(job: Job, logs: JobLog[]): JobRecord {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    error: job.error,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    updatedAt: job.updated_at,
    logs: logs.map(function mapLog(log) {
      return {
        id: log.id,
        level: log.level,
        message: log.message,
        createdAt: log.created_at,
      };
    }),
  };
}

function sanitizeLogMessage(message: string): string {
  return message
    .replace(/password=[^ '\n]+/gi, 'password=***')
    .replace(/secret[ _-]?access[ _-]?key(?:\s*[=:]?\s*[^ '\n]+)?/gi, 'secret_access_key=***')
    .replace(/access[ _-]?key[ _-]?id(?:\s*[=:]?\s*[^ '\n]+)?/gi, 'access_key_id=***')
    .slice(0, 4000);
}
