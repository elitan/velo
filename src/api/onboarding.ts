import { z } from 'zod';
import { publicProcedure } from './context';
import { userFacingError } from './errors';
import { saveAppPassword } from '#server/services/app-auth-service';
import { saveProject } from '#server/services/project-service';

const appPasswordInput = z.object({
  username: z.string().min(1),
  password: z.string().min(8),
});

const projectInput = z.object({
  name: z.string().min(1),
  postgresVersion: z.string().min(1).optional(),
  databaseName: z.string().min(1).optional(),
  appUser: z.string().min(1).optional(),
});

export const onboardingRouter = {
  appPassword: {
    update: publicProcedure.input(appPasswordInput).handler(async function updateAppPassword({ input }) {
      try {
        return await saveAppPassword(input);
      } catch (error) {
        throw userFacingError(error, 'Could not save app password');
      }
    }),
  },
  project: {
    update: publicProcedure.input(projectInput).handler(async function updateProject({ input }) {
      try {
        return await saveProject(input);
      } catch (error) {
        throw userFacingError(error, 'Could not save project');
      }
    }),
  },
};
