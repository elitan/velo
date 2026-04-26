/**
 * State backup and restore tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { StateManager } from '../src/managers/state';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('State Backup and Restore', () => {
  const testDir = '/tmp/velo-state-test';
  const stateFile = path.join(testDir, 'state.json');
  const backupFile = `${stateFile}.backup`;
  let state: StateManager;

  beforeEach(async () => {
    // Create test directory
    await fs.mkdir(testDir, { recursive: true });

    // Clean up any existing files
    try {
      await fs.unlink(stateFile);
    } catch (error) {
      // File doesn't exist, that's fine
    }
    try {
      await fs.unlink(backupFile);
    } catch (error) {
      // File doesn't exist, that's fine
    }

    state = new StateManager(stateFile);
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Directory doesn't exist, that's fine
    }
  });

  describe('Automatic Backup Creation', () => {
    test('should store dataset base without pool name', async () => {
      await state.initialize('tank', 'velo/databases');

      const stateData = state.getState();
      expect(stateData.zfsPool).toBe('tank');
      expect(stateData.zfsDatasetBase).toBe('velo/databases');
    });

    test('should NOT create backup on first save (no existing state)', async () => {
      // Initialize and save for first time
      await state.initialize('tank', 'velo/databases');

      // Backup should NOT exist (no previous state to backup)
      const hasBackup = await state.hasBackup();
      expect(hasBackup).toBe(false);

      // State file should exist
      const stateExists = await Bun.file(stateFile).exists();
      expect(stateExists).toBe(true);
    });

    test('should create backup on second save', async () => {
      // First save
      await state.initialize('tank', 'velo/databases');

      // Modify state and save again
      await state.load();
      const stateData = state.getState();
      stateData.projects = []; // Modify something
      await state.save();

      // Backup should now exist
      const hasBackup = await state.hasBackup();
      expect(hasBackup).toBe(true);

      // Backup file should exist
      const backupExists = await Bun.file(backupFile).exists();
      expect(backupExists).toBe(true);
    });

    test('should overwrite previous backup on each save', async () => {
      // First save
      await state.initialize('tank', 'velo/databases');

      // Second save (creates first backup)
      await state.load();
      await state.save();

      // Get backup timestamp
      const firstBackupInfo = await state.getBackupInfo();
      const firstTimestamp = firstBackupInfo.modifiedAt?.getTime();

      // Wait a bit to ensure different timestamp
      await Bun.sleep(100);

      // Third save (overwrites backup)
      await state.load();
      await state.save();

      const secondBackupInfo = await state.getBackupInfo();
      const secondTimestamp = secondBackupInfo.modifiedAt?.getTime();

      // Timestamps should be different (backup was overwritten)
      expect(secondTimestamp).not.toBe(firstTimestamp);
    });

    test('backup should contain previous state content', async () => {
      // Initialize with specific data
      await state.initialize('tank', 'velo/databases');
      await state.load();

      const originalState = state.getState();
      const originalInitializedAt = originalState.initializedAt;

      // Modify and save (creates backup of original)
      await state.load();
      const stateData = state.getState();
      stateData.initializedAt = '2025-01-01T00:00:00.000Z'; // Change something
      await state.save();

      // Read backup file directly
      const backupContent = await Bun.file(backupFile).text();
      const backupData = JSON.parse(backupContent);

      // Backup should contain original initializedAt, not the new one
      expect(backupData.initializedAt).toBe(originalInitializedAt);
      expect(backupData.initializedAt).not.toBe('2025-01-01T00:00:00.000Z');
    });
  });

  describe('Backup Info', () => {
    test('hasBackup() should return false when no backup exists', async () => {
      const hasBackup = await state.hasBackup();
      expect(hasBackup).toBe(false);
    });

    test('hasBackup() should return true when backup exists', async () => {
      // Create state and backup
      await state.initialize('tank', 'velo/databases');
      await state.load();
      await state.save();

      const hasBackup = await state.hasBackup();
      expect(hasBackup).toBe(true);
    });

    test('getBackupInfo() should return exists: false when no backup', async () => {
      const info = await state.getBackupInfo();
      expect(info.exists).toBe(false);
      expect(info.modifiedAt).toBeUndefined();
      expect(info.size).toBeUndefined();
    });

    test('getBackupInfo() should return metadata when backup exists', async () => {
      // Create state and backup
      await state.initialize('tank', 'velo/databases');
      await state.load();
      await state.save();

      const info = await state.getBackupInfo();
      expect(info.exists).toBe(true);
      expect(info.modifiedAt).toBeInstanceOf(Date);
      expect(info.size).toBeGreaterThan(0);
    });
  });

  describe('Restore from Backup', () => {
    test('should fail to restore when no backup exists', async () => {
      await expect(state.restoreFromBackup()).rejects.toThrow('No backup file found');
    });

    test('should restore state from backup', async () => {
      // Create initial state
      await state.initialize('tank', 'velo/databases');
      await state.load();

      const originalState = state.getState();
      const originalInitializedAt = originalState.initializedAt;

      // Modify and save (creates backup of original)
      await state.load();
      const stateData = state.getState();
      stateData.initializedAt = '2025-01-01T00:00:00.000Z';
      await state.save();

      // Verify state was modified
      await state.load();
      const modifiedState = state.getState();
      expect(modifiedState.initializedAt).toBe('2025-01-01T00:00:00.000Z');

      // Restore from backup
      await state.restoreFromBackup();

      // State should be restored to original
      const restoredState = state.getState();
      expect(restoredState.initializedAt).toBe(originalInitializedAt);
      expect(restoredState.initializedAt).not.toBe('2025-01-01T00:00:00.000Z');
    });

    test('should reload state after restore', async () => {
      // Create initial state with specific pool
      await state.initialize('tank', 'velo/databases');
      await state.load();

      // Modify and save
      await state.load();
      const stateData = state.getState();
      stateData.zfsPool = 'different-pool';
      await state.save();

      // Restore from backup
      await state.restoreFromBackup();

      // State should be loaded and accessible
      const restoredState = state.getState();
      expect(restoredState.zfsPool).toBe('tank');
      expect(restoredState.zfsPool).not.toBe('different-pool');
    });

    test('restored state file should match backup content', async () => {
      // Create initial state
      await state.initialize('tank', 'velo/databases');
      await state.load();
      await state.save(); // Create backup

      // Modify state
      await state.load();
      const stateData = state.getState();
      stateData.zfsPool = 'modified';
      await state.save();

      // Read backup content before restore
      const backupContentBefore = await Bun.file(backupFile).text();

      // Restore
      await state.restoreFromBackup();

      // Read state file after restore
      const stateContentAfter = await Bun.file(stateFile).text();

      // State file should match backup
      expect(stateContentAfter).toBe(backupContentBefore);
    });
  });

  describe('Backup Atomicity', () => {
    test('backup should only be created after successful state write', async () => {
      // Initialize state
      await state.initialize('tank', 'velo/databases');

      // State exists, backup doesn't
      const stateExists = await Bun.file(stateFile).exists();
      const backupExists = await Bun.file(backupFile).exists();

      expect(stateExists).toBe(true);
      expect(backupExists).toBe(false);

      // Second save creates backup
      await state.load();
      await state.save();

      // Both should exist now
      const stateExists2 = await Bun.file(stateFile).exists();
      const backupExists2 = await Bun.file(backupFile).exists();

      expect(stateExists2).toBe(true);
      expect(backupExists2).toBe(true);
    });
  });
});
