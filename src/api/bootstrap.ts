import { z } from 'zod';
import { publicProcedure } from './context';
import { createJob, getActiveJob } from '#server/services/job-service';

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

    const job = await createJob('setup');
    return job;
  }),
};
