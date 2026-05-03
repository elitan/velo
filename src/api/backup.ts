import { z } from 'zod';
import { publicProcedure } from './context';
import { userFacingError } from './errors';
import { saveBackupSettings } from '#server/services/settings-service';

const backupInput = z.object({
  enabled: z.boolean(),
  endpoint: z.string(),
  bucket: z.string(),
  region: z.string(),
  accessKeyId: z.string(),
  secretAccessKey: z.string().optional(),
  path: z.string(),
  pitrDays: z.number().int().positive().optional(),
  fullBackupRetentionDays: z.number().int().positive().optional(),
});

export const backupRouter = {
  settings: {
    update: publicProcedure.input(backupInput).handler(async function updateBackupSettings({ input }) {
      try {
        return await saveBackupSettings(input);
      } catch (error) {
        throw userFacingError(error, 'Could not save backup settings');
      }
    }),
  },
};
