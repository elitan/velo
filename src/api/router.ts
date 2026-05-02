import { createRouterClient } from '@orpc/server';
import { backupRouter } from './backup';
import { bootstrapRouter } from './bootstrap';
import { branchesRouter } from './branches';
import { createOrpcContext } from './context';
import { dashboardRouter } from './dashboard';
import { jobsRouter } from './jobs';
import { replicaBaseRouter } from './replica-base';
import { serversRouter } from './servers';

export const appRouter = {
  dashboard: dashboardRouter,
  jobs: jobsRouter,
  servers: serversRouter,
  backup: backupRouter,
  bootstrap: bootstrapRouter,
  replicaBase: replicaBaseRouter,
  branches: branchesRouter,
};

export type AppRouter = typeof appRouter;

export function createApiClient() {
  return createRouterClient(appRouter, {
    context: createOrpcContext,
  });
}
