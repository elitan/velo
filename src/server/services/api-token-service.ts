import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { getDb } from '#db/client';

const TOKEN_PREFIX = 'velo_';

export interface ApiTokenRecord {
  id: number;
  name: string;
  tokenPrefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateApiTokenResult {
  token: string;
  apiToken: ApiTokenRecord;
}

export async function createApiToken(name: string): Promise<CreateApiTokenResult> {
  const tokenName = name.trim();

  if (!tokenName) {
    throw new Error('API key name is required');
  }

  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const row = await getDb()
    .insertInto('apiTokens')
    .values({
      name: tokenName,
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, 13),
    })
    .returning([
      'id',
      'name',
      'tokenPrefix',
      'lastUsedAt',
      'revokedAt',
      'createdAt',
      'updatedAt',
    ])
    .executeTakeFirstOrThrow();

  return {
    token,
    apiToken: mapApiToken(row),
  };
}

export async function listApiTokens(): Promise<ApiTokenRecord[]> {
  const rows = await getDb()
    .selectFrom('apiTokens')
    .select([
      'id',
      'name',
      'tokenPrefix',
      'lastUsedAt',
      'revokedAt',
      'createdAt',
      'updatedAt',
    ])
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .execute();

  return rows.map(mapApiToken);
}

export async function revokeApiToken(id: number): Promise<ApiTokenRecord> {
  const existing = await getDb()
    .selectFrom('apiTokens')
    .select(['id'])
    .where('id', '=', id)
    .executeTakeFirst();

  if (!existing) {
    throw new Error('API key not found');
  }

  const row = await getDb()
    .updateTable('apiTokens')
    .set({
      revokedAt: sql<string>`datetime('now')`,
      updatedAt: sql<string>`datetime('now')`,
    })
    .where('id', '=', id)
    .returning([
      'id',
      'name',
      'tokenPrefix',
      'lastUsedAt',
      'revokedAt',
      'createdAt',
      'updatedAt',
    ])
    .executeTakeFirstOrThrow();

  return mapApiToken(row);
}

export async function verifyApiToken(token: string): Promise<boolean> {
  if (!token.startsWith(TOKEN_PREFIX)) {
    return false;
  }

  const row = await getDb()
    .selectFrom('apiTokens')
    .select(['id'])
    .where('tokenHash', '=', hashToken(token))
    .where('revokedAt', 'is', null)
    .executeTakeFirst();

  if (!row) {
    return false;
  }

  await getDb()
    .updateTable('apiTokens')
    .set({
      lastUsedAt: sql<string>`datetime('now')`,
      updatedAt: sql<string>`datetime('now')`,
    })
    .where('id', '=', row.id)
    .execute();

  return true;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function mapApiToken(row: {
  id: number;
  name: string;
  tokenPrefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}): ApiTokenRecord {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
