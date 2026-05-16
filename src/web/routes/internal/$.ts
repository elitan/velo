import { createFileRoute } from '@tanstack/react-router';
import {
  listProxyBranches,
  startBranchForProxy,
  stopBranchForProxy,
  touchBranchActivity,
} from '#server/services/branch-service';

export const Route = createFileRoute('/internal/$')({
  server: {
    handlers: {
      GET: handleInternalRequest,
      POST: handleInternalRequest,
    },
  },
});

async function handleInternalRequest(context: { request: Request }): Promise<Response> {
  const auth = authorizeInternalRequest(context.request);

  if (auth) {
    return auth;
  }

  const url = new URL(context.request.url);
  const path = url.pathname.replace(/^\/internal\/?/, '');

  try {
    if (context.request.method === 'GET' && path === 'proxy/branches') {
      return Response.json({ branches: await listProxyBranches() });
    }

    const match = /^branches\/([0-9]+)\/(start|stop|touch)$/.exec(path);

    if (!match || context.request.method !== 'POST') {
      return new Response('Not Found', { status: 404 });
    }

    const branchId = Number(match[1]);
    const action = match[2];

    if (action === 'start') {
      return Response.json(await startBranchForProxy(branchId));
    }

    if (action === 'stop') {
      return Response.json(await stopBranchForProxy(branchId));
    }

    await touchBranchActivity(branchId);
    return Response.json({ id: branchId, touched: true });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}

function authorizeInternalRequest(request: Request): Response | null {
  const token = process.env.VELO_INTERNAL_TOKEN;

  if (!token) {
    return new Response('Internal token not configured', { status: 503 });
  }

  if (request.headers.get('authorization') === `Bearer ${token}`) {
    return null;
  }

  if (request.headers.get('x-velo-internal-token') === token) {
    return null;
  }

  return new Response('Unauthorized', { status: 401 });
}
