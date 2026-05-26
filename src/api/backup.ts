import { z } from 'zod';
import { publicProcedure } from './context';
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
    update: publicProcedure
      .route({ method: 'PUT', path: '/backup/settings', summary: 'Update backup settings' })
      .input(backupInput)
      .handler(async function updateBackupSettings({ input }) {
        return saveBackupSettings(input);
      }),
  },
};
