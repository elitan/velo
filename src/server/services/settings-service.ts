import { sql } from 'kysely';
import { getDb } from '../../db/client';

const BACKUP_SETTING_KEYS = [
  'backup.s3.enabled',
  'backup.s3.endpoint',
  'backup.s3.bucket',
  'backup.s3.region',
  'backup.s3.accessKeyId',
  'backup.s3.secretAccessKey',
  'backup.s3.path',
] as const;

export interface BackupSettingsInput {
  enabled: boolean;
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey?: string;
  path: string;
}

export interface BackupSettings {
  enabled: boolean;
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretConfigured: boolean;
  path: string;
}

export async function getSetting(key: string): Promise<string | null> {
  const row = await getDb()
    .selectFrom('settings')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst();

  return row?.value ?? null;
}

export async function getSettings(keys: readonly string[]): Promise<Record<string, string>> {
  if (keys.length === 0) {
    return {};
  }

  const rows = await getDb()
    .selectFrom('settings')
    .select(['key', 'value'])
    .where('key', 'in', keys)
    .execute();

  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }

  return settings;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await getDb()
    .insertInto('settings')
    .values({ key, value })
    .onConflict(function updateExisting(oc) {
      return oc.column('key').doUpdateSet({
        value,
        updated_at: sql`datetime('now')`,
      });
    })
    .execute();
}

export async function saveBackupSettings(input: BackupSettingsInput): Promise<BackupSettings> {
  await Promise.all([
    setSetting('backup.s3.enabled', input.enabled ? 'true' : 'false'),
    setSetting('backup.s3.endpoint', input.endpoint.trim()),
    setSetting('backup.s3.bucket', input.bucket.trim()),
    setSetting('backup.s3.region', input.region.trim() || 'auto'),
    setSetting('backup.s3.accessKeyId', input.accessKeyId.trim()),
    setSetting('backup.s3.path', normalizeBackupPath(input.path)),
  ]);

  if (input.secretAccessKey && input.secretAccessKey.trim()) {
    await setSetting('backup.s3.secretAccessKey', input.secretAccessKey.trim());
  }

  return getBackupSettings();
}

export async function getBackupSettings(): Promise<BackupSettings> {
  const settings = await getSettings(BACKUP_SETTING_KEYS);

  return {
    enabled: settings['backup.s3.enabled'] === 'true',
    endpoint: settings['backup.s3.endpoint'] || '',
    bucket: settings['backup.s3.bucket'] || '',
    region: settings['backup.s3.region'] || 'auto',
    accessKeyId: settings['backup.s3.accessKeyId'] || '',
    secretConfigured: Boolean(settings['backup.s3.secretAccessKey']),
    path: settings['backup.s3.path'] || '/prod',
  };
}

function normalizeBackupPath(path: string): string {
  const trimmed = path.trim();

  if (!trimmed) {
    return '/prod';
  }

  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
