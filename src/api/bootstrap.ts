import { z } from 'zod';
import { getDb } from '#db/client';
import { assertOk } from './helpers';
import { publicProcedure } from './context';
import { runDevBootstrap, runProdBootstrap } from '#server/services/bootstrap-service';
import { createJob, getActiveJob, runJob } from '#server/services/job-service';
import { createBranchFromBase } from '#server/services/branch-service';
import { createReplicaBase } from '#server/services/replica-service';
import { checkServer } from '#server/services/setup-state-service';

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
    runJob(job, async function runBootstrapJob(context) {
      if (input.target === 'prod') {
        await context.log('installing prod Postgres and backups');
        assertOk(await runProdBootstrap());
        return;
      }

      await context.log('installing dev prerequisites');
      assertOk(await runDevBootstrap());
    });
    return job;
  }),
  complete: publicProcedure.handler(async function completeSetup() {
    const active = await getActiveJob('setup');
    if (active) {
      return active;
    }

    const job = await createJob('setup');
    runJob(job, async function runSetupJob(context) {
      if (!(await isStepDone('dev-check'))) {
        await context.log('setting up dev server');
        assertOk(await runDevBootstrap());
      }

      if (!(await isStepDone('prod-check'))) {
        await context.log('checking prod server');
        await checkServer('prod');
      }

      if (!(await isStepDone('prod-setup')) || !(await isStepDone('backups'))) {
        await context.log('setting up prod Postgres and backups');
        assertOk(await runProdBootstrap());
      }

      if (!(await isStepDone('replica'))) {
        await context.log('creating dev replica base');
        assertOk(await createReplicaBase());
      }

      if (!(await isStepDone('first-branch'))) {
        await context.log('creating first dev branch');
        await createBranchFromBase({ name: 'dev' });
      }
    });
    return job;
  }),
};

async function isStepDone(key: string): Promise<boolean> {
  const step = await getDb()
    .selectFrom('setupSteps')
    .select(['status'])
    .where('key', '=', key)
    .executeTakeFirst();

  return step?.status === 'done';
}
