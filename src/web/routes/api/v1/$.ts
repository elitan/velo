import { RPCHandler } from '@orpc/server/fetch';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { onError } from '@orpc/server';
import { createFileRoute } from '@tanstack/react-router';
import { appRouter } from '#api/router';
import { createOrpcContext } from '#api/context';
import { OPEN_API_TAG_DEFINITIONS } from '#api/openapi-tags';
import { getRequestAuthState } from '#server/auth';
import { jobHandlers } from '#server/services/job-handlers';
import { startJobWorker, type JobWorker } from '#server/services/job-service';

const openApiHandler = new OpenAPIHandler(appRouter, {
  filter: hasExplicitOpenApiRoute,
  interceptors: [
    onError(function logOpenApiError(error) {
      console.error(error);
    }),
  ],
});

const openApiGenerator = new OpenAPIGenerator({
  schemaConverters: [new ZodToJsonSchemaConverter()],
});

const rpcHandler = new RPCHandler(appRouter, {
  interceptors: [
    onError(function logOrpcError(error) {
      console.error(error);
    }),
  ],
});

export const Route = createFileRoute('/api/v1/$')({
  server: {
    handlers: {
      ANY: handleApiRequest,
    },
  },
});

export async function handleApiRequest(context: { request: Request }, options: { startDevJobWorker?: boolean } = {}) {
  if (options.startDevJobWorker !== false) {
    startDevJobWorker();
  }

  const auth = await getRequestAuthState(context.request);

  if (!auth.passwordConfigured && !auth.bearerAuthenticated) {
    return Response.json({ error: 'Auth setup required.' }, { status: 401 });
  }

  if (!auth.authenticated) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  if (new URL(context.request.url).pathname === '/api/v1/openapi.json') {
    return Response.json(await getOpenApiDocument());
  }

  const openApiResult = await openApiHandler.handle(context.request, {
    prefix: '/api/v1',
    context: createOrpcContext(),
  });

  if (openApiResult.matched) {
    return openApiResult.response;
  }

  const rpcResult = await rpcHandler.handle(context.request, {
    prefix: '/api/v1',
    context: createOrpcContext(),
  });

  return rpcResult.response ?? new Response('Not Found', { status: 404 });
}

function hasExplicitOpenApiRoute(options: { contract: { '~orpc': { route: { path?: string } } } }): boolean {
  return Boolean(options.contract['~orpc'].route.path);
}

async function getOpenApiDocument() {
  return openApiGenerator.generate(appRouter, {
    info: {
      title: 'Velo API',
      version: '1.0.0',
    },
    tags: OPEN_API_TAG_DEFINITIONS,
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
        },
      },
    },
    security: [{ bearerAuth: [] }],
    filter: hasExplicitOpenApiRoute,
  });
}

let devJobWorker: JobWorker | null = null;

function startDevJobWorker() {
  if (process.env.NODE_ENV === 'production' || devJobWorker) {
    return;
  }

  devJobWorker = startJobWorker(jobHandlers);
}
