import { os } from '@orpc/server';

export interface OrpcContext {}

export function createOrpcContext(): OrpcContext {
  return {};
}

export const publicProcedure = os.$context<OrpcContext>();
