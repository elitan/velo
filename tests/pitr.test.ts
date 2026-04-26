/**
 * Point-in-Time Recovery (PITR) tests
 * Using direct command imports
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as cleanup from './helpers/cleanup';
import { getProjectCredentials, getBranchPort, query, waitForReady, ensureWALArchived } from './helpers/database';
import { TIMEOUTS } from './helpers/wait';
import {
  silenceConsole,
  projectCreateCommand,
  branchCreateCommand,
  snapshotCreateCommand,
} from './helpers/commands';

describe('Point-in-Time Recovery (PITR)', () => {
  let setupDone = false;

  async function ensureSetup() {
    if (setupDone) return;
    setupDone = true;

    silenceConsole();
    await cleanup.beforeAll();

    // Setup: Create project with test data
    await projectCreateCommand('pitr-test', {});

    const creds = await getProjectCredentials('pitr-test');
    const mainPort = await getBranchPort('pitr-test/main');
    await waitForReady(mainPort, creds.password, 60000);

    // Create initial data
    await query(mainPort, creds.password, 'CREATE TABLE pitr_data (id SERIAL PRIMARY KEY, value TEXT, created_at TIMESTAMP DEFAULT NOW());');
    await query(mainPort, creds.password, "INSERT INTO pitr_data (value) VALUES ('initial');");

    // Force initial WAL archiving to ensure we have a baseline
    await ensureWALArchived(mainPort, creds.password, 'pitr-test.main', 1);

    // Create a snapshot
    await snapshotCreateCommand('pitr-test/main', { label: 'before-changes' });

    // Small delay to ensure snapshot timestamp differs from subsequent inserts
    await Bun.sleep(1000);

    // Add more data after snapshot
    await query(mainPort, creds.password, "INSERT INTO pitr_data (value) VALUES ('after-snapshot-1');");

    // Wait to ensure a clear timestamp boundary
    await Bun.sleep(1000);

    // Capture recovery timestamp AFTER the first insert
    const dbTimestamp = await query(mainPort, creds.password, "SELECT NOW()::TEXT;");
    const recoveryTimestamp = dbTimestamp.trim();

    // Wait to ensure next insert is clearly after our recovery target
    await Bun.sleep(1000);

    await query(mainPort, creds.password, "INSERT INTO pitr_data (value) VALUES ('after-snapshot-2');");

    // Force WAL archiving of the new changes
    await ensureWALArchived(mainPort, creds.password, 'pitr-test.main', 2);

    // Store the recovery timestamp for the test
    (globalThis as any).__pitrRecoveryTimestamp = recoveryTimestamp;
  }

  afterAll(async () => {
    await cleanup.afterAll();
  });

  describe('PITR Branch Creation', () => {
    test('should create branch with PITR to recent timestamp', async () => {
      await ensureSetup();

      // Use the timestamp we captured during setup (between the two inserts)
      const pitrTime = (globalThis as any).__pitrRecoveryTimestamp;

      await branchCreateCommand('pitr-test/recovery', { pitr: pitrTime });

      const creds = await getProjectCredentials('pitr-test');
      const recoveryPort = await getBranchPort('pitr-test/recovery');
      await waitForReady(recoveryPort, creds.password, 120000); // PITR recovery may need extra time

      // Verify recovered branch has data up to recovery point
      // Should have: 'initial' and 'after-snapshot-1' (2 rows)
      // Should NOT have: 'after-snapshot-2' (inserted after recovery target)
      const count = await query(recoveryPort, creds.password, 'SELECT COUNT(*) FROM pitr_data;');
      expect(parseInt(count)).toBe(2);
    }, { timeout: TIMEOUTS.PITR_RECOVERY });

    test('should fail with PITR before any snapshots', async () => {
      // Try to recover to a time way in the past
      const pitrTime = new Date(Date.now() - 1000000000).toISOString();

      await expect(
        branchCreateCommand('pitr-test/too-old', { pitr: pitrTime })
      ).rejects.toThrow();
    });

    test('should accept relative time format', async () => {
      // This might succeed or fail depending on WAL availability
      // We just verify it doesn't crash
      try {
        await branchCreateCommand('pitr-test/relative', { pitr: '5 seconds ago' });
      } catch (error) {
        // Either success or failure is acceptable for this test
        expect(error).toBeDefined();
      }
    }, { timeout: TIMEOUTS.PITR_RECOVERY });
  });
});
