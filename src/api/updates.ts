import { z } from 'zod';
import { publicProcedure } from './context';
import {
  applyUpdate,
  checkForUpdate,
  clearPersistedUpdateResult,
  getAutoUpdateSettings,
  getCurrentVersion,
  getPersistedUpdateResult,
  getUpdateStatus,
  saveAutoUpdateSettings,
} from '#server/services/update-service';

const autoUpdateInput = z.object({
  enabled: z.boolean().optional(),
  applyPatches: z.boolean().optional(),
  applyMigrations: z.boolean().optional(),
  hour: z.number().min(0).max(23).optional(),
});

export const updatesRouter = {
  get: publicProcedure.handler(async function getUpdates() {
    return formatUpdateInfo(await getUpdateStatus());
  }),
  check: publicProcedure.handler(async function checkUpdates() {
    return formatUpdateInfo(await checkForUpdate(true));
  }),
  apply: publicProcedure.handler(async function applyAvailableUpdate() {
    const result = await applyUpdate();

    if (!result.success) {
      throw new Error(result.error || 'Could not apply update.');
    }

    return { success: true };
  }),
  result: publicProcedure.handler(async function getUpdateResult() {
    return (await getPersistedUpdateResult()) || {
      completed: false,
      success: false,
      newVersion: null,
      log: null,
    };
  }),
  clearResult: publicProcedure.handler(async function clearUpdateResult() {
    await clearPersistedUpdateResult();
    return { success: true };
  }),
  auto: {
    get: publicProcedure.handler(async function getAutoUpdates() {
      return getAutoUpdateSettings();
    }),
    update: publicProcedure.input(autoUpdateInput).handler(async function updateAutoUpdates({ input }) {
      return saveAutoUpdateSettings(input);
    }),
  },
};

function formatUpdateInfo(info: Awaited<ReturnType<typeof getUpdateStatus>>) {
  return {
    currentVersion: info.currentVersion,
    latestVersion: info.availableVersion,
    updateAvailable: Boolean(info.availableVersion),
    releaseNotes: info.releaseNotes,
    publishedAt: info.publishedAt,
    htmlUrl: info.htmlUrl,
    hasMigrations: info.hasMigrations,
    lastCheck: info.lastCheck ? new Date(info.lastCheck).toISOString() : null,
    restarting: false,
  };
}
