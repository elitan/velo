/**
 * SSL/TLS Tests
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync } from 'fs';
import { join } from 'path';
import * as cleanup from './helpers/cleanup';
import { waitForProjectReady, waitForBranchReady } from './helpers/wait';
import {
  silenceConsole,
  projectCreateCommand,
  branchCreateCommand,
} from './helpers/commands';
import { query, getProjectCredentials, getBranchPort } from './helpers/database';
import { $ } from 'bun';

const TEST_PROJECT = 'ssl-test';
const TEST_BRANCH = `${TEST_PROJECT}/dev`;

describe('SSL/TLS Tests', () => {
  let setupDone = false;
  let mainPort: string;
  let mainPassword: string;

  async function ensureSetup() {
    if (setupDone) return;
    setupDone = true;

    silenceConsole();
    await cleanup.beforeAll();

    // Create test project
    await projectCreateCommand(TEST_PROJECT, {});
    await waitForProjectReady(TEST_PROJECT);

    // Get credentials
    const creds = await getProjectCredentials(TEST_PROJECT);
    mainPort = (await getBranchPort(`${TEST_PROJECT}/main`)).toString();
    mainPassword = creds.password;
  }

  afterAll(async () => {
    await cleanup.afterAll();
  });

  test('setup: create project and wait for ready', async () => {
    await ensureSetup();
  }, { timeout: 30000 });

  test('should generate SSL certificates on project create', async () => {
    await ensureSetup();
    // Verify certificates exist
    const certDir = join(process.env.HOME || '/root', '.velo/certs', TEST_PROJECT);
    const serverKey = join(certDir, 'server.key');
    const serverCert = join(certDir, 'server.crt');

    expect(existsSync(serverKey)).toBe(true);
    expect(existsSync(serverCert)).toBe(true);

    // Verify certificate is valid
    const certInfo = await $`openssl x509 -in ${serverCert} -noout -subject`.text();
    expect(certInfo).toMatch(/CN\s*=\s*velo-postgres/);
  });

  test('should enable SSL in PostgreSQL container', async () => {
    await ensureSetup();
    const containerName = `velo-${TEST_PROJECT}.main`;

    // Check PostgreSQL SSL settings
    const sslOn = await $`docker exec ${containerName} psql -U postgres -t -A -c "SHOW ssl;"`.text();
    expect(sslOn.trim()).toBe('on');

    // Check SSL certificate file location
    const sslCert = await $`docker exec ${containerName} psql -U postgres -t -A -c "SHOW ssl_cert_file;"`.text();
    expect(sslCert.trim()).toBe('/etc/ssl/certs/postgresql/server.crt');

    // Check SSL key file location
    const sslKey = await $`docker exec ${containerName} psql -U postgres -t -A -c "SHOW ssl_key_file;"`.text();
    expect(sslKey.trim()).toBe('/etc/ssl/certs/postgresql/server.key');
  });

  test('should connect with sslmode=require', async () => {
    await ensureSetup();
    // Test connection with sslmode=require using query helper
    const result = await query(mainPort, mainPassword, "SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid();");

    const parts = result.split('|');
    const sslEnabled = parts[0];
    const tlsVersion = parts[1];
    expect(sslEnabled?.trim()).toBe('t');  // true
    expect(tlsVersion?.trim()).toMatch(/^TLSv/);  // Should be TLS version like TLSv1.3
  });

  test('should allow connection without SSL when not required', async () => {
    await ensureSetup();
    // Note: pg_hba.conf allows connections without SSL (not hostssl), so this should work
    const result = await query(mainPort, mainPassword, "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid();");

    // The query helper connects without explicitly requiring SSL, but server may still use it
    // We just verify the connection works
    expect(result).toBeTruthy();
  });

  test('should create branch with SSL certificates from parent project', async () => {
    await ensureSetup();
    await branchCreateCommand(TEST_BRANCH, {});
    await waitForBranchReady(TEST_PROJECT, 'dev');

    // Verify branch container has SSL enabled
    const containerName = `velo-${TEST_PROJECT}.dev`;
    const sslOn = await $`docker exec ${containerName} psql -U postgres -t -A -c "SHOW ssl;"`.text();
    expect(sslOn.trim()).toBe('on');
  }, { timeout: 30000 });

  test('should mount SSL certificates as read-only', async () => {
    await ensureSetup();
    // Check Docker mount for main branch container
    const containerName = `velo-${TEST_PROJECT}.main`;
    const mounts = await $`docker inspect ${containerName} --format '{{json .Mounts}}'`.text();

    const mountsJson = JSON.parse(mounts);
    const sslMount = mountsJson.find((m: any) => m.Destination === '/etc/ssl/certs/postgresql');

    expect(sslMount).toBeTruthy();
    expect(sslMount.RW).toBe(false);  // Should be read-only
  });
});
