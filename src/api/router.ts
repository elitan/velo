import { createRouterClient } from '@orpc/server';
import { apiKeysRouter } from './api-keys';
import { backupRouter } from './backup';
import { branchesRouter } from './branches';
import { createOrpcContext } from './context';
import { dashboardRouter } from './dashboard';
import { jobsRouter } from './jobs';
import { serversRouter } from './servers';
import { tablesRouter } from './tables';
import { updatesRouter } from './updates';

export const appRouter = {
  apiKeys: apiKeysRouter,
  dashboard: dashboardRouter,
  jobs: jobsRouter,
  servers: serversRouter,
  backup: backupRouter,
  branches: branchesRouter,
  tables: tablesRouter,
  updates: updatesRouter,
};

export type AppRouter = typeof appRouter;

export function createApiClient() {
  return createRouterClient(appRouter, {
    context: createOrpcContext,
  });
}
