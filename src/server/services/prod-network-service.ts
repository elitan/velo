import { isIP } from 'node:net';
import { getDb } from '../../db/client';
import { getSetting, setSetting } from './settings-service';

const PROD_ALLOWED_CIDR_KEY = 'prod.allowedCidr';

export async function getProdAllowedCidr(): Promise<string> {
  const configured = await getSetting(PROD_ALLOWED_CIDR_KEY);
  if (configured) {
    return normalizeAllowedCidr(configured);
  }

  const devServer = await getDb()
    .selectFrom('servers')
    .select('host')
    .where('role', '=', 'dev')
    .executeTakeFirst();

  return defaultCidrForHost(devServer?.host || '');
}

export async function saveProdAllowedCidr(value: string): Promise<string> {
  const cidr = normalizeAllowedCidr(value);
  await setSetting(PROD_ALLOWED_CIDR_KEY, cidr);
  return cidr;
}

export function defaultCidrForHost(host: string): string {
  const normalized = host.trim();
  if (!normalized) {
    throw new Error('Set the dev server host or production allowed CIDR before production setup.');
  }

  const version = isIP(normalized);
  if (version === 4) {
    return `${normalized}/32`;
  }

  if (version === 6) {
    return `${normalized}/128`;
  }

  return normalizeAllowedCidr(normalized);
}

export function normalizeAllowedCidr(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Production allowed CIDR is required.');
  }

  const parts = trimmed.split('/');
  if (parts.length !== 2) {
    throw new Error('Production allowed CIDR must be a CIDR block, like 203.0.113.10/32.');
  }

  const [address, prefixText] = parts;
  const version = isIP(address || '');
  const prefix = Number(prefixText);

  if (!version || !Number.isInteger(prefix)) {
    throw new Error('Production allowed CIDR must be a valid IPv4 or IPv6 CIDR block.');
  }

  if (version === 4 && (prefix < 0 || prefix > 32)) {
    throw new Error('IPv4 CIDR prefix must be between 0 and 32.');
  }

  if (version === 6 && (prefix < 0 || prefix > 128)) {
    throw new Error('IPv6 CIDR prefix must be between 0 and 128.');
  }

  return `${address}/${prefix}`;
}
