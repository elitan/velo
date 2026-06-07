import { z } from 'zod';
import { publicProcedure } from './context';
import { OPEN_API_TAGS } from './openapi-tags';
import { getDb } from '#db/client';
import { createJob } from '#server/services/job-service';
import { isLocalDockerMode } from '#server/services/local-docker-service';
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

export const backupRouter = publicProcedure.tag(OPEN_API_TAGS.backup).router({
  settings: {
    update: publicProcedure
      .route({
        method: 'PUT',
        path: '/backup/settings',
        summary: 'Update backup settings',
      })
      .input(backupInput)
      .handler(async function updateBackupSettings({ input }) {
        const settings = await saveBackupSettings(input);
        const job = await queueBackupReconfigureIfReady();

        return {
          settings,
          jobId: job?.id ?? null,
        };
      }),
  },
});

async function queueBackupReconfigureIfReady() {
  if (isLocalDockerMode()) {
    return null;
  }

  const db = getDb();
  const [prod, prodSetup, backups] = await Promise.all([
    db
      .selectFrom('servers')
      .select(['id'])
      .where('role', '=', 'prod')
      .executeTakeFirst(),
    db
      .selectFrom('setupSteps')
      .select(['status'])
      .where('key', '=', 'prod-setup')
      .executeTakeFirst(),
    db
      .selectFrom('setupSteps')
      .select(['status'])
      .where('key', '=', 'backups')
      .executeTakeFirst(),
  ]);

  if (!prod || prodSetup?.status !== 'done' || backups?.status !== 'done') {
    return null;
  }

  return createJob('backup-reconfigure');
}
