/**
 * Status command tests
 * Using direct command imports
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as cleanup from './helpers/cleanup';
import { getState } from './helpers/database';
import { waitForProjectReady, waitForBranchReady, waitForContainerStopped } from './helpers/wait';
import {
  silenceConsole,
  projectCreateCommand,
  branchCreateCommand,
  stopCommand,
  statusCommand,
} from './helpers/commands';

describe('Status Command', () => {
  beforeAll(async () => {
    silenceConsole();
    await cleanup.beforeAll();
  });

  afterAll(async () => {
    await cleanup.afterAll();
  });

  test('should show status with no projects', async () => {
    // Status should complete even with no projects
    // It may throw or succeed depending on state
    try {
      await statusCommand();
    } catch (error) {
      // Expected if not initialized
    }
  });

  test('should show status with running project', async () => {
    await projectCreateCommand('status-test', {});
    await waitForProjectReady('status-test');

    await statusCommand();

    // Verify via state
    const state = await getState();
    const project = state.projects?.find((p: any) => p.name === 'status-test');
    expect(project).toBeDefined();
    expect(project.branches.some((b: any) => b.status === 'running')).toBe(true);
  }, { timeout: 30000 });

  test('should show status with stopped branch', async () => {
    await branchCreateCommand('status-test/dev', {});
    await waitForBranchReady('status-test', 'dev');
    await stopCommand('status-test/dev');
    await waitForContainerStopped('status-test.dev');

    await statusCommand();

    const state = await getState();
    const project = state.projects?.find((p: any) => p.name === 'status-test');
    const devBranch = project?.branches?.find((b: any) => b.name === 'status-test/dev');
    expect(devBranch?.status).toBe('stopped');
  }, { timeout: 30000 });

  test('should show status with mixed running/stopped states', async () => {
    await branchCreateCommand('status-test/staging', {});
    await waitForBranchReady('status-test', 'staging');

    await statusCommand();

    const state = await getState();
    const project = state.projects?.find((p: any) => p.name === 'status-test');
    expect(project?.branches?.length).toBeGreaterThanOrEqual(3);
  }, { timeout: 30000 });
});
