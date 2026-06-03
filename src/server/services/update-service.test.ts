import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '#db/client';
import { migrateDatabase } from '#db/migrate';
import { checkForUpdate, getCurrentVersion, getUpdateStatus } from './update-service';

let testDir: string;
let originalFetch: typeof fetch;

beforeEach(function setupDatabase() {
  originalFetch = globalThis.fetch;
  testDir = mkdtempSync(join(tmpdir(), 'velo-update-service-'));
  process.env.VELO_DB = join(testDir, 'velo.sqlite');
  migrateDatabase();
});

afterEach(async function cleanupDatabase() {
  globalThis.fetch = originalFetch;
  await closeDb();
  delete process.env.VELO_DB;
  rmSync(testDir, { recursive: true, force: true });
});

describe('update service', function updateService() {
  test('stores latest release and available update details', async function testAvailableUpdate() {
    const currentVersion = getCurrentVersion();
    const latestVersion = incrementPatchVersion(currentVersion);

    globalThis.fetch = createFetchMock({
      latestStatus: 200,
      latestBody: releaseBody(latestVersion),
      migrationFiles: [],
    });

    const update = await checkForUpdate(true);

    expect(update.currentVersion).toBe(currentVersion);
    expect(update.latestVersion).toBe(latestVersion);
    expect(update.availableVersion).toBe(latestVersion);
    expect(update.htmlUrl).toBe(`https://github.com/elitan/velo/releases/tag/v${latestVersion}`);
    expect(update.checkStatus).toBe('ok');

    const status = await getUpdateStatus();
    expect(status.latestVersion).toBe(latestVersion);
    expect(status.availableVersion).toBe(latestVersion);
    expect(status.releaseNotes).toContain(`Release notes for ${latestVersion}`);
  });

  test('keeps latest release link when already current', async function testCurrentRelease() {
    const currentVersion = getCurrentVersion();

    globalThis.fetch = createFetchMock({
      latestStatus: 200,
      latestBody: releaseBody(currentVersion),
      migrationFiles: [],
    });

    const update = await checkForUpdate(true);

    expect(update.latestVersion).toBe(currentVersion);
    expect(update.availableVersion).toBeNull();
    expect(update.htmlUrl).toBe(`https://github.com/elitan/velo/releases/tag/v${currentVersion}`);
    expect(update.checkStatus).toBe('ok');
  });

  test('keeps cached release data when GitHub rate limits a check', async function testRateLimitState() {
    const latestVersion = incrementPatchVersion(getCurrentVersion());

    globalThis.fetch = createFetchMock({
      latestStatus: 200,
      latestBody: releaseBody(latestVersion),
      migrationFiles: [],
    });

    await checkForUpdate(true);

    globalThis.fetch = createFetchMock({
      latestStatus: 403,
      latestBody: { message: 'API rate limit exceeded' },
      rateLimited: true,
      migrationFiles: [],
    });

    const update = await checkForUpdate(true);

    expect(update.latestVersion).toBe(latestVersion);
    expect(update.availableVersion).toBe(latestVersion);
    expect(update.checkStatus).toBe('rate_limited');
    expect(update.checkMessage).toContain('rate limit');
  });
});

interface FetchMockOptions {
  latestStatus: number;
  latestBody: unknown;
  migrationFiles: Array<{ name: string; sha: string; type: string }>;
  rateLimited?: boolean;
}

function createFetchMock(options: FetchMockOptions): typeof fetch {
  return async function fetchMock(input: RequestInfo | URL): Promise<Response> {
    const url = String(input);

    if (url.includes('/releases/latest')) {
      const headers = new Headers();
      if (options.rateLimited) {
        headers.set('x-ratelimit-remaining', '0');
      }

      return jsonResponse(options.latestBody, options.latestStatus, headers);
    }

    if (url.includes('/contents/src/db/migrations')) {
      return jsonResponse(options.migrationFiles, 200, new Headers());
    }

    throw new Error(`Unexpected URL: ${url}`);
  } as typeof fetch;
}

function releaseBody(version: string) {
  return {
    tag_name: `v${version}`,
    body: `Release notes for ${version}`,
    published_at: '2026-05-16T00:00:00.000Z',
    html_url: `https://github.com/elitan/velo/releases/tag/v${version}`,
    draft: false,
    prerelease: false,
  };
}

function incrementPatchVersion(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number);
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`Invalid version: ${version}`);
  }

  return `${major}.${minor}.${patch + 1}`;
}

function jsonResponse(body: unknown, status: number, headers: Headers): Response {
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { status, headers });
}
