import { os } from '@orpc/server';
import { internalError } from './errors';

export interface OrpcContext {}

export function createOrpcContext(): OrpcContext {
  return {};
}

export const surfaceFullErrorMiddleware = os.middleware(async function surfaceFullError({ next }) {
  try {
    return await next();
  } catch (error) {
    throw internalError(error, 'Request failed');
  }
});

export const publicProcedure = os.$context<OrpcContext>().use(surfaceFullErrorMiddleware);
