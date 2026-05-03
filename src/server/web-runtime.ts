import { readFile, stat } from 'node:fs/promises';
import { join, normalize, relative } from 'node:path';
import { migrateDatabase } from '#db/migrate';
import { persistUpdateResult } from '#server/services/update-service';
import { startUpdateScheduler } from '#server/services/update-scheduler';
import { startBranchCleanupScheduler } from '#server/services/branch-cleanup-scheduler';

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);
const clientDir = join(process.cwd(), 'dist/client');

migrateDatabase();
await persistUpdateResult();
startUpdateScheduler();
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
    const authResponse = requireBasicAuth(request);

    if (authResponse) {
      return authResponse;
    }

    const staticResponse = await serveStaticAsset(request);

    if (staticResponse) {
      return staticResponse;
    }

    return serverEntry.default.fetch(request);
  },
});

console.log(`Started server: http://${host}:${port}`);

function requireBasicAuth(request: Request): Response | null {
  const username = process.env.VELO_BASIC_AUTH_USERNAME || '';
  const password = process.env.VELO_BASIC_AUTH_PASSWORD || '';

  if (!username || !password) {
    return null;
  }

  const header = request.headers.get('authorization') || '';
  const prefix = 'Basic ';

  if (!header.startsWith(prefix)) {
    return unauthorizedResponse();
  }

  const decoded = Buffer.from(header.slice(prefix.length), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');

  if (separator === -1) {
    return unauthorizedResponse();
  }

  const providedUsername = decoded.slice(0, separator);
  const providedPassword = decoded.slice(separator + 1);

  if (providedUsername !== username || providedPassword !== password) {
    return unauthorizedResponse();
  }

  return null;
}

function unauthorizedResponse(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Velo"',
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
