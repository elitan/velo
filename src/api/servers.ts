import { z } from 'zod';
import { publicProcedure } from './context';
import { userFacingError } from './errors';
import { checkServer, saveServer } from '#server/services/setup-state-service';

const serverInput = z.object({
  role: z.enum(['prod', 'dev']),
  host: z.string().min(1),
  sshUser: z.string().min(1),
  sshKeyPath: z.string().min(1),
});

export const serversRouter = {
  update: publicProcedure.input(serverInput).handler(async function updateServer({ input }) {
    try {
      return await saveServer(input);
    } catch (error) {
      throw userFacingError(error, 'Could not save server');
    }
  }),
  check: publicProcedure
    .input(z.object({ role: z.enum(['prod', 'dev']) }))
    .handler(async function checkServerHealth({ input }) {
      try {
        return await checkServer(input.role);
      } catch (error) {
        throw userFacingError(error, 'Could not check server');
      }
    }),
};
