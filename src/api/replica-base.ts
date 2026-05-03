import { publicProcedure } from './context';
import { createJob, getActiveJob } from '#server/services/job-service';

export const replicaBaseRouter = {
  create: publicProcedure.handler(async function createReplicaBaseJob() {
    const active = await getActiveJob('replica-base');
    if (active) {
      return active;
    }

    const job = await createJob('replica-base');
    return job;
  }),
};
