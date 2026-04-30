import { readFile, stat } from 'node:fs/promises';
import { join, normalize, relative } from 'node:path';

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);
const clientDir = join(process.cwd(), 'dist/client');
const serverEntry = await import('../../dist/server/server.js');

Bun.serve({
  hostname: host,
  port,
  async fetch(request) {
    const staticResponse = await serveStaticAsset(request);

    if (staticResponse) {
      return staticResponse;
    }

    return serverEntry.default.fetch(request);
  },
});

console.log(`Started server: http://${host}:${port}`);

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
