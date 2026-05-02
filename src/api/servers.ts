import { z } from 'zod';
import { publicProcedure } from './context';
import { checkServer, saveServer } from '#server/services/setup-state-service';

const serverInput = z.object({
  role: z.enum(['prod', 'dev']),
  host: z.string().min(1),
  sshUser: z.string().min(1),
  sshKeyPath: z.string().min(1),
});

export const serversRouter = {
  update: publicProcedure.input(serverInput).handler(async function updateServer({ input }) {
    return saveServer(input);
  }),
  check: publicProcedure
    .input(z.object({ role: z.enum(['prod', 'dev']) }))
    .handler(async function checkServerHealth({ input }) {
      return checkServer(input.role);
    }),
};
