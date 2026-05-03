import { createRouterClient } from '@orpc/server';
import { backupRouter } from './backup';
import { bootstrapRouter } from './bootstrap';
import { branchesRouter } from './branches';
import { createOrpcContext } from './context';
import { dashboardRouter } from './dashboard';
import { jobsRouter } from './jobs';
import { onboardingRouter } from './onboarding';
import { replicaBaseRouter } from './replica-base';
import { serversRouter } from './servers';
import { tablesRouter } from './tables';
import { updatesRouter } from './updates';

export const appRouter = {
  dashboard: dashboardRouter,
  jobs: jobsRouter,
  onboarding: onboardingRouter,
  servers: serversRouter,
  backup: backupRouter,
  bootstrap: bootstrapRouter,
  replicaBase: replicaBaseRouter,
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
