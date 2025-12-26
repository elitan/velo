import { PATHS } from '../utils/paths';
import { $ } from 'bun';
import { CLI_NAME } from '../config/constants';

export interface WALArchiveInfo {
  datasetName: string;
  path: string;
  sizeBytes: number;
  fileCount: number;
  oldestWAL: string | null;
  newestWAL: string | null;
  oldestTimestamp: Date | null;
  newestTimestamp: Date | null;
}

export class WALManager {
  /**
   * Get WAL archive path for a dataset
   */
  getArchivePath(datasetName: string): string {
    return `${PATHS.WAL_ARCHIVE}/${datasetName}`;
  }

  /**
   * Ensure WAL archive directory exists for a dataset
   * Sets permissions to allow Docker postgres user (UID 70/999) to write
   */
  async ensureArchiveDir(datasetName: string): Promise<void> {
    const walArchivePath = this.getArchivePath(datasetName);
    await $`mkdir -p ${walArchivePath}`.quiet();
    // Set ownership to postgres user/group (UID/GID 70) with restrictive permissions
    await $`chmod 770 ${walArchivePath}`.quiet();
    await $`sudo chown 70:70 ${walArchivePath}`.quiet();
    // Create .keep file to preserve directory
    await Bun.write(`${walArchivePath}/.keep`, '');
    await $`chmod 660 ${walArchivePath}/.keep`.quiet();
  }

  /**
   * Get WAL archive information for a dataset
   */
  async getArchiveInfo(datasetName: string): Promise<WALArchiveInfo> {
    const walArchivePath = this.getArchivePath(datasetName);

    // Ensure directory exists
    await this.ensureArchiveDir(datasetName);

    // Get file count and size
    let fileCount = 0;
    let sizeBytes = 0;
    let oldestWAL: string | null = null;
    let newestWAL: string | null = null;
    let oldestTimestamp: Date | null = null;
    let newestTimestamp: Date | null = null;

    try {
      const files = await Array.fromAsync(
        new Bun.Glob('*').scan({ cwd: walArchivePath })
      );

      // Filter out .keep files
      const walFiles = files.filter(f => f !== '.keep' && !f.startsWith('.'));
      fileCount = walFiles.length;

      if (walFiles.length > 0) {
        // Sort by filename (WAL files are named sequentially)
        walFiles.sort();
        oldestWAL = walFiles[0] ?? null;
        newestWAL = walFiles[walFiles.length - 1] ?? null;

        // Get timestamps from file modification times
        const oldestFile = Bun.file(`${walArchivePath}/${oldestWAL}`);
        const newestFile = Bun.file(`${walArchivePath}/${newestWAL}`);

        oldestTimestamp = new Date(oldestFile.lastModified);
        newestTimestamp = new Date(newestFile.lastModified);

        // Calculate total size
        for (const file of walFiles) {
          const fileInfo = Bun.file(`${walArchivePath}/${file}`);
          sizeBytes += fileInfo.size;
        }
      }
    } catch (error) {
      // Directory doesn't exist or is empty
    }

    return {
      datasetName,
      path: walArchivePath,
      sizeBytes,
      fileCount,
      oldestWAL,
      newestWAL,
      oldestTimestamp,
      newestTimestamp,
    };
  }

  /**
   * Clean up WAL files older than a certain date
   * Returns number of files deleted
   */
  async cleanupWALsBefore(datasetName: string, beforeDate: Date): Promise<number> {
    const walArchivePath = this.getArchivePath(datasetName);
    const cutoffTime = beforeDate.getTime();

    let deletedCount = 0;

    try {
      const files = await Array.fromAsync(
        new Bun.Glob('*').scan({ cwd: walArchivePath })
      );

      for (const file of files) {
        if (file === '.keep' || file.startsWith('.')) continue;

        const filePath = `${walArchivePath}/${file}`;
        const fileInfo = Bun.file(filePath);
        const exists = await fileInfo.exists();

        if (exists && fileInfo.lastModified < cutoffTime) {
          await $`rm ${filePath}`.quiet();
          deletedCount++;
        }
      }
    } catch (error) {
      // Ignore errors
    }

    return deletedCount;
  }

  /**
   * Clean up WAL files older than retention days
   */
  async cleanupOldWALs(datasetName: string, retentionDays: number): Promise<number> {
    const beforeDate = new Date(Date.now() - (retentionDays * 24 * 60 * 60 * 1000));
    return this.cleanupWALsBefore(datasetName, beforeDate);
  }

  /**
   * Verify WAL archive integrity by checking for gaps
   */
  async verifyArchiveIntegrity(datasetName: string): Promise<{ valid: boolean; gaps: string[] }> {
    const walArchivePath = this.getArchivePath(datasetName);
    const gaps: string[] = [];

    try {
      const files = await Array.fromAsync(
        new Bun.Glob('*').scan({ cwd: walArchivePath })
      );

      const walFiles = files.filter(f => f !== '.keep' && !f.startsWith('.')).sort();

      if (walFiles.length < 2) {
        return { valid: true, gaps: [] };
      }

      // WAL files follow a pattern: 000000010000000000000001, 000000010000000000000002, etc.
      // We'll do a simple check for sequential naming
      for (let i = 0; i < walFiles.length - 1; i++) {
        const current = walFiles[i];
        const next = walFiles[i + 1];

        if (!current || !next) continue; // Skip if undefined

        // Extract the numeric part (last 8 hex digits)
        const currentNum = parseInt(current.slice(-8), 16);
        const nextNum = parseInt(next.slice(-8), 16);

        if (nextNum - currentNum > 1) {
          gaps.push(`Gap between ${current} and ${next}`);
        }
      }

      return { valid: gaps.length === 0, gaps };
    } catch (error) {
      return { valid: false, gaps: ['Error reading WAL archive'] };
    }
  }

  /**
   * Delete WAL archive directory for a dataset
   * This should be called when deleting a project or branch
   */
  async deleteArchiveDir(datasetName: string): Promise<void> {
    const walArchivePath = this.getArchivePath(datasetName);
    try {
      await $`rm -rf ${walArchivePath}`.quiet();
    } catch (error) {
      // Ignore errors if directory doesn't exist
    }
  }

  /**
   * Setup recovery configuration for PITR
   * This configures PostgreSQL to replay WALs to a specific point in time
   *
   * Note: This must be called BEFORE the container is created.
   * The ZFS dataset is mounted with permissions that allow the current user to write.
   * We write files as the current user and Docker's PostgreSQL container will have
   * the correct ownership when it starts (postgres user inside container).
   */
  async setupPITRecovery(
    targetMountpoint: string,
    walArchivePath: string,
    recoveryTarget?: Date
  ): Promise<void> {
    const pgdataPath = `${targetMountpoint}/pgdata`;

    // Create recovery.signal file for PostgreSQL 12+
    // We can write directly since the ZFS dataset is owned by the current user
    await Bun.write(`${pgdataPath}/recovery.signal`, '');

    // Set permissions to 600 (owner read/write only)
    // PostgreSQL requires strict permissions on config files
    await $`chmod 600 ${pgdataPath}/recovery.signal`.quiet();

    // Create recovery configuration
    let recoveryConf = `restore_command = 'cp ${walArchivePath}/%f %p'\n`;

    if (recoveryTarget) {
      // Format: YYYY-MM-DD HH:MM:SS
      const timestamp = recoveryTarget.toISOString().replace('T', ' ').slice(0, 19);
      recoveryConf += `recovery_target_time = '${timestamp}'\n`;
    }

    recoveryConf += `recovery_target_action = 'promote'\n`;

    // For PostgreSQL 12+, write to postgresql.auto.conf
    await Bun.write(`${pgdataPath}/postgresql.auto.conf`, recoveryConf);
    await $`chmod 600 ${pgdataPath}/postgresql.auto.conf`.quiet();
  }
}
