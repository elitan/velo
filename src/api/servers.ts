import { z } from 'zod';
import { publicProcedure } from './context';
import { OPEN_API_TAGS } from './openapi-tags';
import { checkServer, saveServer } from '#server/services/setup-state-service';

const serverInput = z.object({
  role: z.enum(['prod', 'dev']),
  host: z.string().min(1),
  sshUser: z.string().min(1),
  sshKeyPath: z.string().min(1),
  allowedCidr: z.string().optional(),
});

export const serversRouter = {
  update: publicProcedure
    .route({ method: 'PUT', path: '/servers/{role}', summary: 'Update server', tags: [OPEN_API_TAGS.servers] })
    .input(serverInput)
    .handler(async function updateServer({ input }) {
      return saveServer(input);
    }),
  check: publicProcedure
    .route({ method: 'POST', path: '/servers/{role}/check', summary: 'Check server', tags: [OPEN_API_TAGS.servers] })
    .input(z.object({ role: z.enum(['prod', 'dev']) }))
    .handler(async function checkServerHealth({ input }) {
      return checkServer(input.role);
    }),
};
