import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPgBackRestConfig } from './bootstrap-service';
import { runCommand } from './command-service';
import { getBackupSettings } from './settings-service';
import { getLocalPgBackRestInfo, isLocalDockerMode } from './local-docker-service';

export interface BackupPoint {
  label: string;
  type: string;
  startedAt: string;
  completedAt: string;
}

export interface BackupAvailability {
  status: 'ok' | 'unavailable';
  message: string | null;
  pitr: {
    from: string | null;
    to: string | null;
  };
  backups: BackupPoint[];
}

interface PgBackRestBackup {
  label?: string;
  type?: string;
  error?: boolean;
  timestamp?: {
    start?: number;
    stop?: number;
  };
}

interface PgBackRestStanza {
  name?: string;
  status?: {
    code?: number;
    message?: string;
  };
  archive?: unknown[];
  backup?: PgBackRestBackup[];
}

export async function getBackupAvailability(): Promise<BackupAvailability> {
  const backup = await getBackupSettings();

  if (isLocalDockerMode()) {
    try {
      return capLocalPitrWindow(parsePgBackRestInfo(await getLocalPgBackRestInfo(), backup.pitrDays));
    } catch (error: any) {
      return unavailable(sanitizeAvailabilityMessage(error?.message || 'Local pgBackRest history could not be read'));
    }
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'velo-pgbackrest-info-'));
  const configPath = join(tempDir, 'pgbackrest.conf');

  try {
    const config = await buildPgBackRestConfig();
    await writeFile(configPath, config.replace('__PGDATA__', '/tmp/velo-pgbackrest-info'), { mode: 0o600 });

    const result = await runCommand([
      'sh',
      '-lc',
      [
        'command -v pgbackrest >/dev/null',
        `pgbackrest --config=${shellQuote(configPath)} --stanza=main info --output=json`,
      ].join('\n'),
    ], 30000);

    if (result.exitCode !== 0) {
      return unavailable(sanitizeAvailabilityMessage(result.stderr || result.stdout || 'pgBackRest info failed'));
    }

    return parsePgBackRestInfo(result.stdout, backup.pitrDays);
  } catch (error: any) {
    return unavailable(sanitizeAvailabilityMessage(error?.message || 'Backup availability could not be read'));
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(function ignoreCleanupError() {});
  }
}

export function parsePgBackRestInfo(value: string, pitrDays: number, now = new Date()): BackupAvailability {
  const parsed = JSON.parse(value) as PgBackRestStanza[];
  const stanza = parsed.find(function findMain(item) {
    return item.name === 'main';
  }) || parsed[0];

  if (!stanza) {
    return unavailable('No pgBackRest stanza found');
  }

  if (stanza.status?.code !== undefined && stanza.status.code !== 0) {
    return unavailable(stanza.status.message || 'pgBackRest stanza is not healthy');
  }

  const validBackups = (stanza.backup || [])
    .filter(function isValidBackup(backup) {
      return backup.error !== true && Boolean(backup.timestamp?.start || backup.timestamp?.stop);
    })
    .sort(function sortOldestFirst(a, b) {
      return getBackupTimestamp(a, 'start') - getBackupTimestamp(b, 'start');
    });

  if (!validBackups.length) {
    return unavailable('No backups found yet');
  }

  const fullBackups = validBackups.filter(function isFullBackup(backup) {
    return backup.type === 'full';
  });
  const dailyBackups = fullBackups.length ? fullBackups : validBackups;
  const oldestBackup = validBackups[0];
  const latestBackup = validBackups[validBackups.length - 1];
  const oldestTimestamp = getBackupTimestamp(oldestBackup, 'start');
  const latestTimestamp = getBackupTimestamp(latestBackup, 'stop');
  const policyMin = now.getTime() - pitrDays * 24 * 60 * 60 * 1000;
  const pitrFrom = new Date(Math.max(oldestTimestamp, policyMin));
  const hasArchive = Boolean(stanza.archive?.length);
  const pitrTo = hasArchive ? now : new Date(latestTimestamp);

  if (pitrFrom.getTime() > pitrTo.getTime()) {
    return unavailable('No PITR range is available yet');
  }

  return {
    status: 'ok',
    message: null,
    pitr: {
      from: pitrFrom.toISOString(),
      to: pitrTo.toISOString(),
    },
    backups: dailyBackups
      .slice()
      .sort(function sortNewestFirst(a, b) {
        return getBackupTimestamp(b, 'stop') - getBackupTimestamp(a, 'stop');
      })
      .map(function mapBackup(backup) {
        return {
          label: backup.label || new Date(getBackupTimestamp(backup, 'stop')).toISOString(),
          type: backup.type || 'backup',
          startedAt: new Date(getBackupTimestamp(backup, 'start')).toISOString(),
          completedAt: new Date(getBackupTimestamp(backup, 'stop')).toISOString(),
        };
      }),
  };
}

function getBackupTimestamp(backup: PgBackRestBackup | undefined, key: 'start' | 'stop'): number {
  const timestamp = key === 'start'
    ? backup?.timestamp?.start || backup?.timestamp?.stop
    : backup?.timestamp?.stop || backup?.timestamp?.start;

  if (!timestamp) {
    return 0;
  }

  return timestamp * 1000;
}

function unavailable(message: string): BackupAvailability {
  return {
    status: 'unavailable',
    message,
    pitr: {
      from: null,
      to: null,
    },
    backups: [],
  };
}

function capLocalPitrWindow(availability: BackupAvailability): BackupAvailability {
  const latestBackup = availability.backups[0];

  if (availability.status !== 'ok' || !latestBackup || !availability.pitr.from) {
    return availability;
  }

  return {
    ...availability,
    pitr: {
      from: availability.pitr.from,
      to: new Date(new Date(latestBackup.completedAt).getTime() + 1000).toISOString(),
    },
  };
}

function sanitizeAvailabilityMessage(message: string): string {
  return message
    .replace(/(repo1-s3-key-secret=)[^\s]+/gi, '$1***')
    .replace(/(repo1-s3-key=)[^\s]+/gi, '$1***')
    .replace(/(password=)[^\s]+/gi, '$1***')
    .slice(0, 240);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
