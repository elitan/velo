import { RPCHandler } from '@orpc/server/fetch';
import { onError } from '@orpc/server';
import { createFileRoute } from '@tanstack/react-router';
import { appRouter } from '#api/router';
import { createOrpcContext } from '#api/context';
import { getAuthState } from '#server/auth';
import { jobHandlers } from '#server/services/job-handlers';
import { startJobWorker, type JobWorker } from '#server/services/job-service';

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
  startDevJobWorker();

  const auth = await getAuthState(context.request);

  if (!auth.configured) {
    return Response.json({ error: 'Auth setup required.' }, { status: 401 });
  }

  if (!auth.authenticated) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const { response } = await handler.handle(context.request, {
    prefix: '/api/v1',
    context: createOrpcContext(),
  });

  return response ?? new Response('Not Found', { status: 404 });
}

let devJobWorker: JobWorker | null = null;

function startDevJobWorker() {
  if (process.env.NODE_ENV === 'production' || devJobWorker) {
    return;
  }

  devJobWorker = startJobWorker(jobHandlers);
}
