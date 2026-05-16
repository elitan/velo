import { exec } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import packageJsonRaw from '../../../package.json';
import { getDatabasePath } from '#db/paths';
import { ensureStateDirectory } from '#db/state-permissions';
import { getSetting, setSetting } from './settings-service';

const execAsync = promisify(exec);
const GITHUB_API = 'https://api.github.com';
const REPO_OWNER = 'elitan';
const REPO_NAME = 'velo';
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_AUTO_UPDATE_HOUR = 4;

interface PackageJson {
  version: string;
}

interface GitHubRelease {
  tag_name: string;
  body: string | null;
  published_at: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

interface GitHubContent {
  name: string;
  sha: string;
  type: string;
}

export interface UpdateInfo {
  currentVersion: string;
  availableVersion: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
  htmlUrl: string | null;
  hasMigrations: boolean;
  lastCheck: number | null;
}

export interface UpdateResult {
  completed: boolean;
  success: boolean;
  newVersion: string | null;
  log: string | null;
}

export interface AutoUpdateSettings {
  enabled: boolean;
  applyPatches: boolean;
  applyMigrations: boolean;
  hour: number;
}

const packageJson = packageJsonRaw as PackageJson;

export function getCurrentVersion(): string {
  return packageJson.version;
}

export function compareVersions(a: string, b: string): number {
  const first = parseVersion(a);
  const second = parseVersion(b);

  if (first.major !== second.major) {
    return first.major - second.major;
  }

  if (first.minor !== second.minor) {
    return first.minor - second.minor;
  }

  return first.patch - second.patch;
}

export async function getUpdateStatus(): Promise<UpdateInfo> {
  const currentVersion = getCurrentVersion();
  const availableVersion = await getSetting('update.available');
  const lastCheck = parseOptionalInteger(await getSetting('update.lastCheck'));

  if (!availableVersion || compareVersions(currentVersion, availableVersion) >= 0) {
    if (availableVersion) {
      await setSetting('update.available', '');
    }

    return {
      currentVersion,
      availableVersion: null,
      releaseNotes: null,
      publishedAt: null,
      htmlUrl: null,
      hasMigrations: false,
      lastCheck,
    };
  }

  return {
    currentVersion,
    availableVersion,
    releaseNotes: await getSetting('update.releaseNotes'),
    publishedAt: await getSetting('update.publishedAt'),
    htmlUrl: await getSetting('update.htmlUrl'),
    hasMigrations: (await getSetting('update.hasMigrations')) === 'true',
    lastCheck,
  };
}

export async function checkForUpdate(force = false): Promise<UpdateInfo> {
  const currentVersion = getCurrentVersion();
  const lastCheck = parseOptionalInteger(await getSetting('update.lastCheck'));

  if (!force && lastCheck && Date.now() - lastCheck < CHECK_INTERVAL_MS) {
    return getUpdateStatus();
  }

  const release = await fetchLatestRelease();
  const now = Date.now();
  await setSetting('update.lastCheck', String(now));

  if (!release) {
    await clearAvailableUpdate();
    return emptyUpdateInfo(currentVersion, now);
  }

  const latestVersion = release.tag_name.replace(/^v/, '');
  if (compareVersions(latestVersion, currentVersion) <= 0) {
    await clearAvailableUpdate();
    return emptyUpdateInfo(currentVersion, now);
  }

  const hasMigrations = await detectMigrations(currentVersion, latestVersion);

  await setSetting('update.available', latestVersion);
  await setSetting('update.releaseNotes', release.body || '');
  await setSetting('update.publishedAt', release.published_at || '');
  await setSetting('update.htmlUrl', release.html_url);
  await setSetting('update.hasMigrations', hasMigrations ? 'true' : 'false');

  return {
    currentVersion,
    availableVersion: latestVersion,
    releaseNotes: release.body || '',
    publishedAt: release.published_at,
    htmlUrl: release.html_url,
    hasMigrations,
    lastCheck: now,
  };
}

export async function applyUpdate(): Promise<{ success: boolean; error?: string }> {
  if (process.env.NODE_ENV !== 'production') {
    return { success: false, error: 'Updates only work in production.' };
  }

  const status = await getUpdateStatus();
  if (!status.availableVersion) {
    return { success: false, error: 'No update available.' };
  }

  try {
    ensureStateDirectory(getDatabasePath());
    writeFileSync(getUpdateMarkerPath(), status.availableVersion, { mode: 0o600 });
    execAsync('systemctl restart velo-web').catch(function ignoreRestartError() {});
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Could not apply update.',
    };
  }
}

export async function getAutoUpdateSettings(): Promise<AutoUpdateSettings> {
  const enabled = await getSetting('update.auto.enabled');
  const applyPatches = await getSetting('update.auto.applyPatches');
  const applyMigrations = await getSetting('update.auto.applyMigrations');
  const hour = parseOptionalInteger(await getSetting('update.auto.hour'));

  return {
    enabled: enabled !== 'false',
    applyPatches: applyPatches === 'true',
    applyMigrations: applyMigrations === 'true',
    hour: hour ?? DEFAULT_AUTO_UPDATE_HOUR,
  };
}

export async function saveAutoUpdateSettings(input: Partial<AutoUpdateSettings>): Promise<AutoUpdateSettings> {
  if (input.enabled !== undefined) {
    await setSetting('update.auto.enabled', input.enabled ? 'true' : 'false');
  }

  if (input.applyPatches !== undefined) {
    await setSetting('update.auto.applyPatches', input.applyPatches ? 'true' : 'false');
  }

  if (input.applyMigrations !== undefined) {
    await setSetting('update.auto.applyMigrations', input.applyMigrations ? 'true' : 'false');
  }

  if (input.hour !== undefined) {
    await setSetting('update.auto.hour', String(clampHour(input.hour)));
  }

  return getAutoUpdateSettings();
}

export async function runAutoUpdateCheck(): Promise<void> {
  const settings = await getAutoUpdateSettings();
  if (!settings.enabled) {
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const lastRun = await getSetting('update.auto.lastRun');
  if (lastRun === today) {
    return;
  }

  const now = new Date();
  if (now.getUTCHours() !== settings.hour) {
    return;
  }

  await setSetting('update.auto.lastRun', today);
  const update = await checkForUpdate(true);
  if (!update.availableVersion) {
    return;
  }

  if (!shouldAutoApply(update, settings)) {
    return;
  }

  await applyUpdate();
}

export function getFileUpdateResult(): UpdateResult {
  const resultPath = getUpdateResultPath();
  if (!existsSync(resultPath)) {
    return { completed: false, success: false, newVersion: null, log: null };
  }

  const content = readFileSync(resultPath, 'utf8').trim();
  const log = existsSync(getUpdateLogPath()) ? readFileSync(getUpdateLogPath(), 'utf8') : null;

  if (content === 'failed') {
    return { completed: true, success: false, newVersion: null, log };
  }

  if (content.startsWith('success:')) {
    return {
      completed: true,
      success: true,
      newVersion: content.replace(/^success:/, ''),
      log,
    };
  }

  return { completed: false, success: false, newVersion: null, log: null };
}

export async function persistUpdateResult(): Promise<void> {
  const result = getFileUpdateResult();
  if (!result.completed) {
    return;
  }

  await setSetting('update.result.success', result.success ? 'true' : 'false');
  await setSetting('update.result.version', result.newVersion || '');
  await setSetting('update.result.log', result.log || '');
  await setSetting('update.result.at', String(Date.now()));

  clearFileUpdateResult();
}

export async function getPersistedUpdateResult(): Promise<UpdateResult | null> {
  const updatedAt = await getSetting('update.result.at');
  if (!updatedAt) {
    return null;
  }

  return {
    completed: true,
    success: (await getSetting('update.result.success')) === 'true',
    newVersion: (await getSetting('update.result.version')) || null,
    log: (await getSetting('update.result.log')) || null,
  };
}

export async function clearPersistedUpdateResult(): Promise<void> {
  await setSetting('update.result.success', '');
  await setSetting('update.result.version', '');
  await setSetting('update.result.log', '');
  await setSetting('update.result.at', '');
}

async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  const response = await fetch(`${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Velo-Updater',
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}`);
  }

  const release = (await response.json()) as GitHubRelease;
  return release.draft || release.prerelease ? null : release;
}

async function detectMigrations(currentVersion: string, newVersion: string): Promise<boolean> {
  const [currentFiles, newFiles] = await Promise.all([
    fetchMigrationFiles(`v${currentVersion.replace(/^v/, '')}`),
    fetchMigrationFiles(`v${newVersion.replace(/^v/, '')}`),
  ]);

  if (!currentFiles || !newFiles) {
    return false;
  }

  if (currentFiles.length !== newFiles.length) {
    return true;
  }

  const currentShas = new Set(currentFiles.map(function getSha(file) {
    return file.sha;
  }));

  return newFiles.some(function hasNewFile(file) {
    return !currentShas.has(file.sha);
  });
}

async function fetchMigrationFiles(ref: string): Promise<GitHubContent[] | null> {
  const response = await fetch(`${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/src/db/migrations?ref=${ref}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Velo-Updater',
    },
  });

  if (!response.ok) {
    return null;
  }

  const content = (await response.json()) as GitHubContent[];
  return content.filter(function isFile(file) {
    return file.type === 'file' && file.name.endsWith('.sql');
  });
}

function shouldAutoApply(update: UpdateInfo, settings: AutoUpdateSettings): boolean {
  if (update.hasMigrations && !settings.applyMigrations) {
    return false;
  }

  if (!settings.applyPatches) {
    return false;
  }

  const current = parseVersion(update.currentVersion);
  const available = parseVersion(update.availableVersion || update.currentVersion);

  return current.major === available.major && current.minor === available.minor && available.patch > current.patch;
}

function parseVersion(version: string) {
  const [major = 0, minor = 0, patch = 0] = version.replace(/^v/, '').split('.').map(function parsePart(part) {
    return Number.parseInt(part, 10) || 0;
  });

  return { major, minor, patch };
}

function emptyUpdateInfo(currentVersion: string, lastCheck: number): UpdateInfo {
  return {
    currentVersion,
    availableVersion: null,
    releaseNotes: null,
    publishedAt: null,
    htmlUrl: null,
    hasMigrations: false,
    lastCheck,
  };
}

async function clearAvailableUpdate(): Promise<void> {
  await setSetting('update.available', '');
  await setSetting('update.releaseNotes', '');
  await setSetting('update.publishedAt', '');
  await setSetting('update.htmlUrl', '');
  await setSetting('update.hasMigrations', 'false');
}

function parseOptionalInteger(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampHour(hour: number): number {
  if (!Number.isFinite(hour)) {
    return DEFAULT_AUTO_UPDATE_HOUR;
  }

  return Math.max(0, Math.min(23, Math.floor(hour)));
}

function getUpdateMarkerPath(): string {
  return join(dirname(getDatabasePath()), '.update-requested');
}

function getUpdateResultPath(): string {
  return join(dirname(getDatabasePath()), '.update-result');
}

function getUpdateLogPath(): string {
  return join(dirname(getDatabasePath()), '.update-log');
}

function clearFileUpdateResult(): void {
  for (const path of [getUpdateResultPath(), getUpdateLogPath()]) {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}
