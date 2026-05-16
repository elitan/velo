import { SQL } from 'bun';
import { getDb } from '#db/client';
import { isConfirmedProductionWrite, isProductionBranchId, isReadOnlySql } from '#utils/prod-write-guard';
import { getSetting } from './settings-service';
import { getActiveJobs } from './job-service';
import { auditProdWriteAttempt } from './prod-write-audit-service';

const STATEMENT_TIMEOUT_MS = 30_000;

export interface RunBranchSqlInput {
  branchId: string;
  sql: string;
  productionWriteConfirmation?: string | undefined;
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

  await assertBranchNotRestoring(input.branchId);
  await assertProductionSqlWriteAllowed(input);

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
  if (isProductionBranchId(branchId)) {
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

async function assertBranchNotRestoring(branchId: string): Promise<void> {
  const activeJobs = await getActiveJobs();
  const normalizedBranchId = isProductionBranchId(branchId) ? 'production' : branchId;
  const activeRestore = activeJobs.some(function findActiveRestore(job) {
    if (job.type !== 'restore-branch' || !job.inputJson) {
      return false;
    }

    try {
      const input = JSON.parse(job.inputJson) as Record<string, unknown>;
      return input.targetBranch === normalizedBranchId;
    } catch {
      return false;
    }
  });

  if (activeRestore) {
    throw new Error(`Branch ${normalizedBranchId} is being restored. Try again after restore completes.`);
  }
}

async function assertProductionSqlWriteAllowed(input: RunBranchSqlInput): Promise<void> {
  if (!isProductionBranchId(input.branchId) || isReadOnlySql(input.sql)) {
    return;
  }

  const allowed = isConfirmedProductionWrite(input.productionWriteConfirmation);
  await auditProdWriteAttempt({
    area: 'sql',
    action: 'run',
    branchId: input.branchId,
    allowed,
    target: summarizeSql(input.sql),
  });

  if (!allowed) {
    throw new Error('Type "write production" to run write SQL on production.');
  }
}

function summarizeSql(sql: string): string {
  const singleLine = sql.trim().replace(/\s+/g, ' ');

  if (singleLine.length <= 120) {
    return singleLine;
  }

  return `${singleLine.slice(0, 117)}...`;
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
