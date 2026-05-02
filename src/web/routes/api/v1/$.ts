import { RPCHandler } from '@orpc/server/fetch';
import { onError } from '@orpc/server';
import { createFileRoute } from '@tanstack/react-router';
import { appRouter } from '#api/router';
import { createOrpcContext } from '#api/context';

const handler = new RPCHandler(appRouter, {
  interceptors: [
    onError(function logOrpcError(error) {
      console.error(error);
    }),
  ],
});

export const Route = createFileRoute('/api/v1/$')({
  server: {
    handlers: {
      ANY: handleRpcRequest,
    },
  },
});

async function handleRpcRequest(context: { request: Request }) {
  const { response } = await handler.handle(context.request, {
    prefix: '/api/v1',
    context: createOrpcContext(),
  });

  return response ?? new Response('Not Found', { status: 404 });
}
