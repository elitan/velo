import { assertOk } from './helpers';
import { publicProcedure } from './context';
import { createJob, getActiveJob, runJob } from '#server/services/job-service';
import { createReplicaBase } from '#server/services/replica-service';

export const replicaBaseRouter = {
  create: publicProcedure.handler(async function createReplicaBaseJob() {
    const active = await getActiveJob('replica-base');
    if (active) {
      return active;
    }

    const job = await createJob('replica-base');
    runJob(job, async function runReplicaBaseJob(context) {
      await context.log('creating dev replica base');
      assertOk(await createReplicaBase());
    });
    return job;
  }),
};
