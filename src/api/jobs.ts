import { z } from 'zod';
import { publicProcedure } from './context';
import { getJob, listJobs } from '#server/services/job-service';

export const jobsRouter = {
  list: publicProcedure.handler(async function listJobsQuery() {
    return listJobs();
  }),
  retrieve: publicProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .handler(async function retrieveJob({ input }) {
      return getJob(input.id);
    }),
};
