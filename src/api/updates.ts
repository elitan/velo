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
  get: publicProcedure
    .route({ method: 'GET', path: '/updates', summary: 'Get update status' })
    .handler(async function getUpdates() {
      return formatUpdateInfo(await getUpdateStatus());
    }),
  check: publicProcedure
    .route({ method: 'POST', path: '/updates/check', summary: 'Check for updates' })
    .handler(async function checkUpdates() {
      return formatUpdateInfo(await checkForUpdate(true));
    }),
  apply: publicProcedure
    .route({ method: 'POST', path: '/updates/apply', summary: 'Apply update' })
    .handler(async function applyAvailableUpdate() {
      const result = await applyUpdate();

      if (!result.success) {
        throw new Error(result.error || 'Could not apply update.');
      }

      return { success: true };
    }),
  result: publicProcedure
    .route({ method: 'GET', path: '/updates/result', summary: 'Get update result' })
    .handler(async function getUpdateResult() {
      return (await getPersistedUpdateResult()) || {
        completed: false,
        success: false,
        newVersion: null,
        log: null,
      };
    }),
  clearResult: publicProcedure
    .route({ method: 'DELETE', path: '/updates/result', summary: 'Clear update result' })
    .handler(async function clearUpdateResult() {
      await clearPersistedUpdateResult();
      return { success: true };
    }),
  auto: {
    get: publicProcedure
      .route({ method: 'GET', path: '/updates/auto', summary: 'Get auto-update settings' })
      .handler(async function getAutoUpdates() {
        return getAutoUpdateSettings();
      }),
    update: publicProcedure
      .route({ method: 'PATCH', path: '/updates/auto', summary: 'Update auto-update settings' })
      .input(autoUpdateInput)
      .handler(async function updateAutoUpdates({ input }) {
        return saveAutoUpdateSettings(input);
      }),
  },
};

function formatUpdateInfo(info: Awaited<ReturnType<typeof getUpdateStatus>>) {
  return {
    currentVersion: info.currentVersion,
    latestVersion: info.latestVersion,
    availableVersion: info.availableVersion,
    updateAvailable: Boolean(info.availableVersion),
    releaseNotes: info.releaseNotes,
    publishedAt: info.publishedAt,
    htmlUrl: info.htmlUrl,
    hasMigrations: info.hasMigrations,
    lastCheck: info.lastCheck ? new Date(info.lastCheck).toISOString() : null,
    checkStatus: info.checkStatus,
    checkMessage: info.checkMessage,
    restarting: false,
  };
}
