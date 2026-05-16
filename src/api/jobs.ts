import { z } from 'zod';
import { publicProcedure } from './context';
import { cancelJobById, getJob, listJobs, retryJobById } from '#server/services/job-service';

const jobStatusInput = z.enum(['queued', 'running', 'done', 'error', 'cancelled']);
const jobIdInput = z.object({ id: z.number().int().positive() });

export const jobsRouter = {
  list: publicProcedure
    .input(z.object({
      limit: z.number().int().positive().max(100).optional(),
      offset: z.number().int().min(0).optional(),
      status: jobStatusInput.optional(),
      type: z.string().min(1).optional(),
    }).optional())
    .handler(async function listJobsQuery({ input }) {
      return listJobs(input?.limit ?? 20, {
        offset: input?.offset,
        status: input?.status,
        type: input?.type,
      });
    }),
  retrieve: publicProcedure
    .input(jobIdInput)
    .handler(async function retrieveJob({ input }) {
      return getJob(input.id);
    }),
  retry: publicProcedure
    .input(jobIdInput)
    .handler(async function retryJob({ input }) {
      return retryJobById(input.id);
    }),
  cancel: publicProcedure
    .input(jobIdInput)
    .handler(async function cancelJob({ input }) {
      return cancelJobById(input.id);
    }),
};
