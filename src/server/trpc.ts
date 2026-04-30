import { initTRPC } from '@trpc/server';

export interface TrpcContext {}

export function createTrpcContext(): TrpcContext {
  return {};
}

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
