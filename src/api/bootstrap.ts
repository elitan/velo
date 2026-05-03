import { z } from 'zod';
import { getDb } from '#db/client';
import { publicProcedure } from './context';
import { userFacingError } from './errors';
import { createJob, getActiveJob } from '#server/services/job-service';
import { getAppAuthState } from '#server/services/app-auth-service';

const bootstrapInput = z.object({
  target: z.enum(['prod', 'dev']),
});

export const bootstrapRouter = {
  start: publicProcedure.input(bootstrapInput).handler(async function startBootstrap({ input }) {
    const jobType = input.target === 'prod' ? 'prod-bootstrap' : 'dev-bootstrap';
    const active = await getActiveJob(jobType);
    if (active) {
      return active;
    }

    const job = await createJob(jobType);
    return job;
  }),
  complete: publicProcedure.handler(async function completeSetup() {
    const active = await getActiveJob('setup');
    if (active) {
      return active;
    }

    try {
      await assertSetupReady();
    } catch (error) {
      throw userFacingError(error, 'Setup is not ready');
    }

    const job = await createJob('setup');
    return job;
  }),
};

async function assertSetupReady(): Promise<void> {
  const db = getDb();
  const [appAuth, project, prodServer, backupConfigDone] = await Promise.all([
    getAppAuthState(),
    db.selectFrom('projects').select('id').orderBy('id').executeTakeFirst(),
    db.selectFrom('servers').select(['id', 'host']).where('role', '=', 'prod').executeTakeFirst(),
    isStepDone('backups-config'),
  ]);

  if (!appAuth.configured) {
    throw new Error('Set the app password first');
  }

  if (!project) {
    throw new Error('Create the project first');
  }

  if (!prodServer?.host) {
    throw new Error('Save the production server first');
  }

  if (!backupConfigDone) {
    throw new Error('Choose backup storage first');
  }
}

async function isStepDone(key: string): Promise<boolean> {
  const step = await getDb()
    .selectFrom('setupSteps')
    .select('status')
    .where('key', '=', key)
    .executeTakeFirst();

  return step?.status === 'done';
}
