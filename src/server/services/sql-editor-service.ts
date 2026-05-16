import { SQL } from 'bun';
import { getDb } from '#db/client';
import { getSetting } from './settings-service';

const STATEMENT_TIMEOUT_MS = 30_000;

export interface RunBranchSqlInput {
  branchId: string;
  sql: string;
}

export interface RunBranchSqlResult {
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
  rowCount: number;
  command: string;
  durationMs: number;
  timeoutMs: number;
}

export async function runBranchSql(input: RunBranchSqlInput): Promise<RunBranchSqlResult> {
  const query = input.sql.trim();

  if (!query) {
    throw new Error('SQL is required');
  }

  const connectionUrl = await getBranchConnectionUrl(input.branchId);
  const client = new SQL({ url: connectionUrl, max: 1 });

  try {
    await client.unsafe(`set statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const startedAt = performance.now();
    const rows = await client.unsafe(query);
    const durationMs = Math.round(performance.now() - startedAt);
    const normalizedRows = Array.from(rows).map(function normalizeRow(row) {
      return normalizeRecord(row as Record<string, unknown>);
    });

    return {
      columns: getColumns(normalizedRows),
      rows: normalizedRows,
      rowCount: Number(rows.count ?? normalizedRows.length),
      command: String(rows.command || 'SQL'),
      durationMs,
      timeoutMs: STATEMENT_TIMEOUT_MS,
    };
  } finally {
    await client.close();
  }
}

async function getBranchConnectionUrl(branchId: string): Promise<string> {
  if (isProductionBranch(branchId)) {
    const connectionUrl = await getSetting('prod.connectionUrl');

    if (!connectionUrl) {
      throw new Error('Production connection URL is not configured');
    }

    return connectionUrl;
  }

  const branch = await getDb()
    .selectFrom('branches')
    .select(['connectionUrl'])
    .where('slug', '=', branchId)
    .executeTakeFirst();

  if (!branch?.connectionUrl) {
    throw new Error(`Branch not found: ${branchId}`);
  }

  return branch.connectionUrl;
}

function isProductionBranch(branchId: string): boolean {
  const normalized = branchId.trim().toLowerCase();
  return normalized === 'production' || normalized === 'prod';
}

function getColumns(rows: Array<Record<string, string | number | boolean | null>>): string[] {
  const columns = new Set<string>();

  rows.forEach(function collectColumns(row) {
    Object.keys(row).forEach(function addColumn(column) {
      columns.add(column);
    });
  });

  return Array.from(columns);
}

function normalizeRecord(row: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const normalized: Record<string, string | number | boolean | null> = {};

  Object.entries(row).forEach(function normalizeEntry([key, value]) {
    normalized[key] = normalizeValue(value);
  });

  return normalized;
}

function normalizeValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  return JSON.stringify(value);
}
