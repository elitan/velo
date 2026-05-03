import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { getDb } from '#db/client';
import { getSetting, getSettings, setSetting } from './settings-service';

const APP_AUTH_KEYS = [
  'app.auth.username',
  'app.auth.passwordHash',
] as const;

const DEFAULT_USERNAME = 'admin';

export interface AppAuthInput {
  username: string;
  password: string;
}

export interface AppAuthState {
  configured: boolean;
  envConfigured: boolean;
  username: string;
}

export async function getAppAuthState(): Promise<AppAuthState> {
  const envUsername = process.env.VELO_BASIC_AUTH_USERNAME || '';
  const envPassword = process.env.VELO_BASIC_AUTH_PASSWORD || '';

  if (envUsername && envPassword) {
    return {
      configured: true,
      envConfigured: true,
      username: envUsername,
    };
  }

  const settings = await getSettings(APP_AUTH_KEYS);
  const username = settings['app.auth.username'] || DEFAULT_USERNAME;

  return {
    configured: Boolean(settings['app.auth.passwordHash']),
    envConfigured: false,
    username,
  };
}

export async function saveAppPassword(input: AppAuthInput): Promise<AppAuthState> {
  const username = input.username.trim() || DEFAULT_USERNAME;
  const password = input.password.trim();

  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  await Promise.all([
    setSetting('app.auth.username', username),
    setSetting('app.auth.passwordHash', hashPassword(password)),
  ]);
  await setAppPasswordStepDone();

  return getAppAuthState();
}

async function setAppPasswordStepDone(): Promise<void> {
  await getDb()
    .updateTable('setupSteps')
    .set({
      status: 'done',
      message: 'app password saved',
      updatedAt: sql`datetime('now')`,
    })
    .where('key', '=', 'app-password')
    .execute();
}

export async function verifyAppPassword(username: string, password: string): Promise<boolean> {
  const state = await getAppAuthState();

  if (!state.configured) {
    return true;
  }

  if (state.envConfigured) {
    return username === state.username && password === (process.env.VELO_BASIC_AUTH_PASSWORD || '');
  }

  if (username !== state.username) {
    return false;
  }

  const passwordHash = await getSetting('app.auth.passwordHash');

  if (!passwordHash) {
    return false;
  }

  return verifyPassword(password, passwordHash);
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');

  return `${salt}:${hash}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(':');

  if (!salt || !hash) {
    return false;
  }

  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, expected.length);

  if (actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
}
