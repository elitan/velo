import { z } from 'zod';
import { publicProcedure } from './context';
import { OPEN_API_TAGS } from './openapi-tags';
import { cancelJobById, getJob, listJobs, retryJobById } from '#server/services/job-service';

const jobStatusInput = z.enum(['queued', 'running', 'done', 'error', 'cancelled']);
const jobIdInput = z.object({ id: z.coerce.number().int().positive() });

export const jobsRouter = {
  list: publicProcedure
    .route({ method: 'GET', path: '/jobs', summary: 'List jobs', tags: [OPEN_API_TAGS.jobs] })
    .input(z.object({
      limit: z.coerce.number().int().positive().max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
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
    .route({ method: 'GET', path: '/jobs/{id}', summary: 'Get job', tags: [OPEN_API_TAGS.jobs] })
    .input(jobIdInput)
    .handler(async function retrieveJob({ input }) {
      return getJob(input.id);
    }),
  retry: publicProcedure
    .route({ method: 'POST', path: '/jobs/{id}/retry', summary: 'Retry job', tags: [OPEN_API_TAGS.jobs] })
    .input(jobIdInput)
    .handler(async function retryJob({ input }) {
      return retryJobById(input.id);
    }),
  cancel: publicProcedure
    .route({ method: 'POST', path: '/jobs/{id}/cancel', summary: 'Cancel job', tags: [OPEN_API_TAGS.jobs] })
    .input(jobIdInput)
    .handler(async function cancelJob({ input }) {
      return cancelJobById(input.id);
    }),
};
