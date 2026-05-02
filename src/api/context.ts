import { os } from '@orpc/server';
import { migrateDatabase } from '#db/migrate';

export interface OrpcContext {}

export function createOrpcContext(): OrpcContext {
  return {};
}

export const publicProcedure = os.$context<OrpcContext>().use(function migrateBeforeProcedure({ next }) {
  migrateDatabase();
  return next();
});
