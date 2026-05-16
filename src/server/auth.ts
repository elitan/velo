import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getSetting, setSetting } from './services/settings-service';

const PASSWORD_HASH_KEY = 'auth.passwordHash';
const SESSION_SECRET_KEY = 'auth.sessionSecret';
const SESSION_COOKIE = 'velo_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const MIN_PASSWORD_LENGTH = 8;

export interface AuthState {
  configured: boolean;
  authenticated: boolean;
}

interface SessionPayload {
  exp: number;
}

export async function getAuthState(request: Request): Promise<AuthState> {
  const configured = await isAuthConfigured();

  if (!configured) {
    return { configured, authenticated: false };
  }

  return {
    configured,
    authenticated: await isAuthenticated(request),
  };
}

export async function isAuthConfigured(): Promise<boolean> {
  return Boolean(await getSetting(PASSWORD_HASH_KEY));
}

export async function isAuthenticated(request: Request): Promise<boolean> {
  const token = getCookie(request, SESSION_COOKIE);

  if (!token) {
    return false;
  }

  const secret = await getSetting(SESSION_SECRET_KEY);

  if (!secret) {
    return false;
  }

  return verifySessionToken(token, secret);
}

export async function setupPassword(password: string): Promise<string> {
  if (await isAuthConfigured()) {
    throw new Error('Auth is already configured.');
  }

  return setPassword(password);
}

export async function setPassword(password: string): Promise<string> {
  validatePassword(password);

  const [hash, secret] = await Promise.all([
    Bun.password.hash(password),
    rotateSessionSecret(),
  ]);

  await setSetting(PASSWORD_HASH_KEY, hash);

  return createSessionToken(secret);
}

export async function verifyPassword(password: string): Promise<boolean> {
  const hash = await getSetting(PASSWORD_HASH_KEY);

  if (!hash) {
    return false;
  }

  return Bun.password.verify(password, hash);
}

export async function createSession(password: string): Promise<string | null> {
  if (!(await verifyPassword(password))) {
    return null;
  }

  const secret = await ensureSessionSecret();

  return createSessionToken(secret);
}

export function sessionCookie(token: string): string {
  return serializeCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: '/',
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
  });
}

export function clearSessionCookie(): string {
  return serializeCookie(SESSION_COOKIE, '', {
    httpOnly: true,
    maxAge: 0,
    path: '/',
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
  });
}

export function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

async function ensureSessionSecret(): Promise<string> {
  const existing = await getSetting(SESSION_SECRET_KEY);

  if (existing) {
    return existing;
  }

  const secret = randomBytes(32).toString('base64url');
  await setSetting(SESSION_SECRET_KEY, secret);

  return secret;
}

async function rotateSessionSecret(): Promise<string> {
  const secret = randomBytes(32).toString('base64url');
  await setSetting(SESSION_SECRET_KEY, secret);

  return secret;
}

function createSessionToken(secret: string): string {
  const payload = encodeJson({
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  });
  const signature = sign(payload, secret);

  return `${payload}.${signature}`;
}

function verifySessionToken(token: string, secret: string): boolean {
  const [payload, signature] = token.split('.');

  if (!payload || !signature) {
    return false;
  }

  if (!safeEqual(signature, sign(payload, secret))) {
    return false;
  }

  const session = decodeJson(payload);

  return Boolean(session && session.exp > Math.floor(Date.now() / 1000));
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function encodeJson(value: SessionPayload): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeJson(value: string): SessionPayload | null {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return null;
  }
}

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie') || '';

  for (const part of cookie.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');

    if (rawKey === name) {
      return rawValue.join('=');
    }
  }

  return null;
}

interface CookieOptions {
  httpOnly: boolean;
  maxAge: number;
  path: string;
  sameSite: 'Lax';
  secure: boolean;
}

function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${value}`,
    `Max-Age=${options.maxAge}`,
    `Path=${options.path}`,
    `SameSite=${options.sameSite}`,
  ];

  if (options.httpOnly) {
    parts.push('HttpOnly');
  }

  if (options.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}
