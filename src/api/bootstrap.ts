import { z } from 'zod';
import { assertOk } from './helpers';
import { publicProcedure } from './context';
import { runDevBootstrap, runProdBootstrap } from '#server/services/bootstrap-service';
import { createJob, getActiveJob, runJob } from '#server/services/job-service';

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
};
