import { createFileRoute } from '@tanstack/react-router';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '../../../../server/root-router';
import { createTrpcContext } from '../../../../server/trpc';

export const Route = createFileRoute('/api/trpc/$')({
  server: {
    handlers: {
      GET: handleTrpcRequest,
      POST: handleTrpcRequest,
    },
  },
});

async function handleTrpcRequest(context: { request: Request }) {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req: context.request,
    router: appRouter,
    createContext: createTrpcContext,
  });
}
