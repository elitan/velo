import { readFile, stat } from 'node:fs/promises';
import { join, normalize, relative } from 'node:path';
import { Database } from 'bun:sqlite';
import { getMigrationsDirectory, migrateDatabase } from '#db/migrate';
import { getDatabasePath } from '#db/paths';
import { getAuthState } from '#server/auth';
import { getControlPlaneState } from '#server/services/setup-state-service';
import { persistUpdateResult } from '#server/services/update-service';
import { startUpdateScheduler } from '#server/services/update-scheduler';
import { jobHandlers } from '#server/services/job-handlers';
import { startJobWorker } from '#server/services/job-service';
import { startBranchCleanupScheduler } from '#server/services/branch-cleanup-scheduler';

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);
const clientDir = join(process.cwd(), 'dist/client');

migrateDatabase();
await persistUpdateResult();
startUpdateScheduler();
startJobWorker(jobHandlers);
startBranchCleanupScheduler();

const serverEntryPath = new URL('../../dist/server/server.js', import.meta.url).href;
const serverEntry = (await import(serverEntryPath)) as {
  default: {
    fetch(request: Request): Response | Promise<Response>;
  };
};

Bun.serve({
  hostname: host,
  port,
  async fetch(request) {
    const healthResponse = await handleHealthCheck(request);

    if (healthResponse) {
      return healthResponse;
    }

    if (isInternalRequest(request)) {
      return serverEntry.default.fetch(request);
    }

    const staticResponse = await serveStaticAsset(request);

    if (staticResponse) {
      return staticResponse;
    }

    const authResponse = await requireAppAuth(request);

    if (authResponse) {
      return authResponse;
    }

    return serverEntry.default.fetch(request);
  },
});

console.log(`Started server: http://${host}:${port}`);

async function handleHealthCheck(request: Request): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname !== '/healthz') {
    return null;
  }

  const requireReady = url.searchParams.get('ready') === '1';
  const checks = {
    web: true,
    sqlite: false,
    migrations: false,
    dashboard: false,
    setup: !requireReady,
    servers: !requireReady,
    prodConnection: !requireReady,
  };
  const errors: string[] = [];

  try {
    const db = new Database(getDatabasePath(), { readonly: true });
    db.query('select 1').get();
    db.close();
    checks.sqlite = true;
  } catch (error) {
    errors.push(`sqlite: ${errorMessage(error)}`);
  }

  try {
    getMigrationsDirectory();
    checks.migrations = true;
  } catch (error) {
    errors.push(`migrations: ${errorMessage(error)}`);
  }

  try {
    const state = await getControlPlaneState();
    checks.dashboard = true;

    if (requireReady) {
      checks.setup = state.setupSteps.length > 0 && state.setupSteps.every(function isDone(step) {
        return step.status === 'done';
      });
      checks.servers = state.servers.length >= 2 && state.servers.every(function isHealthy(server) {
        return server.status === 'ok';
      });
      checks.prodConnection = Boolean(state.prodConnectionUrl);

      if (!checks.setup) {
        errors.push('setup: not all setup steps are done');
      }

      if (!checks.servers) {
        errors.push('servers: expected healthy dev and prod servers');
      }

      if (!checks.prodConnection) {
        errors.push('prodConnection: missing production connection URL');
      }
    }
  } catch (error) {
    errors.push(`dashboard: ${errorMessage(error)}`);
  }

  const ok = Object.values(checks).every(Boolean);

  return Response.json({
    ok,
    mode: requireReady ? 'ready' : 'runtime',
    checks,
    errors,
  }, { status: ok ? 200 : 503 });
}

function isInternalRequest(request: Request): boolean {
  return new URL(request.url).pathname.startsWith('/internal/');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function requireAppAuth(request: Request): Promise<Response | null> {
  const url = new URL(request.url);

  if (isPublicPath(url.pathname)) {
    return null;
  }

  const auth = await getAuthState(request);

  if (!auth.configured) {
    if (url.pathname.startsWith('/api/')) {
      return Response.json({ error: 'Auth setup required.' }, { status: 401 });
    }

    return redirect('/setup');
  }

  if (auth.authenticated) {
    if (url.pathname === '/login' || url.pathname === '/setup') {
      return redirect('/');
    }

    return null;
  }

  if (url.pathname.startsWith('/api/')) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
}

function isPublicPath(pathname: string): boolean {
  return pathname === '/healthz'
    || pathname.startsWith('/api/auth/')
    || pathname === '/api/auth'
    || pathname === '/login'
    || pathname === '/setup';
}

function redirect(pathname: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: pathname,
    },
  });
}

async function serveStaticAsset(request: Request): Promise<Response | null> {
  const url = new URL(request.url);

  if (!url.pathname.startsWith('/assets/')) {
    return null;
  }

  const filePath = normalize(join(clientDir, decodeURIComponent(url.pathname)));
  const relativePath = relative(clientDir, filePath);

  if (relativePath.startsWith('..') || relativePath.startsWith('/')) {
    return new Response('Not Found', { status: 404 });
  }

  try {
    const info = await stat(filePath);

    if (!info.isFile()) {
      return new Response('Not Found', { status: 404 });
    }

    const file = await readFile(filePath);

    const body = new Uint8Array(file);

    return new Response(body, {
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Type': getContentType(filePath),
      },
    });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
}

function getContentType(filePath: string): string {
  if (filePath.endsWith('.css')) {
    return 'text/css; charset=utf-8';
  }

  if (filePath.endsWith('.js')) {
    return 'text/javascript; charset=utf-8';
  }

  if (filePath.endsWith('.svg')) {
    return 'image/svg+xml';
  }

  if (filePath.endsWith('.png')) {
    return 'image/png';
  }

  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
    return 'image/jpeg';
  }

  if (filePath.endsWith('.webp')) {
    return 'image/webp';
  }

  return 'application/octet-stream';
}
