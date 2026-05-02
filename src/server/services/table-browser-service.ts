import { SQL } from 'bun';
import { getDb } from '#db/client';
import { getSetting } from './settings-service';

export interface TableBrowserInput {
  branchId: string;
  database?: string | undefined;
  schema?: string | undefined;
  table?: string | undefined;
}

export interface TableRowsInput {
  branchId: string;
  database: string;
  schema: string;
  table: string;
  offset?: number | undefined;
}

export interface TableRowInsertInput {
  branchId: string;
  database: string;
  schema: string;
  table: string;
  values: Record<string, string | null>;
}

export interface TableRowUpdateInput extends TableRowInsertInput {
  rowId: string;
}

export interface TableRowDeleteInput {
  branchId: string;
  database: string;
  schema: string;
  table: string;
  rowId: string;
}

export interface TableBrowserTable {
  schema: string;
  name: string;
  rowEstimate: number;
}

export interface TableBrowserColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  ordinal: number;
}

export interface TableBrowserMetadata {
  branchId: string;
  databases: string[];
  selectedDatabase: string;
  schemas: string[];
  selectedSchema: string | null;
  tables: TableBrowserTable[];
  selectedTable: TableBrowserTable | null;
  elapsedMs: number;
}

export interface TableRowsResult {
  branchId: string;
  database: string;
  schema: string;
  table: string;
  columns: TableBrowserColumn[];
  rows: Array<Record<string, unknown>>;
  rowLimit: number;
  rowOffset: number;
  rowCount: number;
  elapsedMs: number;
}

export interface TableBrowserResult extends TableBrowserMetadata, TableRowsResult {
  columns: TableBrowserColumn[];
  rows: Array<Record<string, unknown>>;
  rowLimit: number;
  rowOffset: number;
  rowCount: number;
}

const ROW_LIMIT = 50;
export const TABLE_ROW_ID_COLUMN = '__velo_ctid';
const BOOLEAN_TYPES = new Set(['boolean']);
const INTEGER_TYPES = new Set(['smallint', 'integer', 'bigint']);
const NUMBER_TYPES = new Set(['real', 'double precision', 'numeric', 'decimal']);
const JSON_TYPES = new Set(['json', 'jsonb']);
const ARRAY_TYPES = new Set(['array']);

export async function getTableBrowser(input: TableBrowserInput): Promise<TableBrowserResult> {
  const metadata = await getTableBrowserMetadata(input);

  if (!metadata.selectedTable || !metadata.selectedSchema) {
    return {
      ...metadata,
      database: metadata.selectedDatabase,
      schema: metadata.selectedSchema || '',
      table: metadata.selectedTable?.name || '',
      columns: [],
      rows: [],
      rowLimit: ROW_LIMIT,
      rowOffset: 0,
      rowCount: 0,
    };
  }

  const rows = await getTableRows({
    branchId: input.branchId,
    database: metadata.selectedDatabase,
    schema: metadata.selectedSchema,
    table: metadata.selectedTable.name,
  });

  return {
    ...metadata,
    ...rows,
  };
}

export async function getTableBrowserMetadata(input: TableBrowserInput): Promise<TableBrowserMetadata> {
  const startedAt = performance.now();
  const connectionUrl = await getBranchConnectionUrl(input.branchId);

  if (!connectionUrl) {
    throw new Error(`No connection string found for ${input.branchId}`);
  }

  let databases: string[];
  let selectedDatabase: string;
  const metadataSql = createSql(connectionUrl);

  try {
    databases = await listDatabases(metadataSql);
    const currentDatabase = await getCurrentDatabase(metadataSql);
    selectedDatabase = selectDatabase(databases, input.database, currentDatabase);
  } finally {
    await metadataSql.close({ timeout: 0 });
  }

  const sql = createSql(withDatabase(connectionUrl, selectedDatabase));

  try {
    const [tables, schemas] = await Promise.all([
      listTables(sql),
      listSchemas(sql),
    ]);
    const selectedSchema = selectSchema(schemas, input.schema);
    const schemaTables = selectedSchema
      ? tables.filter(function tableInSchema(table) {
        return table.schema === selectedSchema;
      })
      : tables;
    const selectedTable = selectTable(schemaTables, selectedSchema || undefined, input.table);

    return {
      branchId: input.branchId,
      databases,
      selectedDatabase,
      schemas,
      selectedSchema,
      tables: schemaTables,
      selectedTable,
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  } finally {
    await sql.close({ timeout: 0 });
  }
}

export async function getTableRows(input: TableRowsInput): Promise<TableRowsResult> {
  const startedAt = performance.now();
  const connectionUrl = await getBranchConnectionUrl(input.branchId);

  if (!connectionUrl) {
    throw new Error(`No connection string found for ${input.branchId}`);
  }

  const sql = createSql(withDatabase(connectionUrl, input.database));

  try {
    const table = {
      schema: input.schema,
      name: input.table,
      rowEstimate: 0,
    };
    const columns = await listColumns(sql, table);
    const rowCount = await countRows(sql, table);
    const rowOffset = normalizeOffset(input.offset, rowCount);
    const rows = await listRows(sql, table, columns, rowOffset);

    return {
      branchId: input.branchId,
      database: input.database,
      schema: input.schema,
      table: input.table,
      columns,
      rows,
      rowLimit: ROW_LIMIT,
      rowOffset,
      rowCount,
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  } finally {
    await sql.close({ timeout: 0 });
  }
}

export async function insertTableRow(input: TableRowInsertInput): Promise<void> {
  const connectionUrl = await getBranchConnectionUrl(input.branchId);

  if (!connectionUrl) {
    throw new Error(`No connection string found for ${input.branchId}`);
  }

  const sql = createSql(withDatabase(connectionUrl, input.database));

  try {
    const table = {
      schema: input.schema,
      name: input.table,
      rowEstimate: 0,
    };
    const columns = await listColumns(sql, table);
    const parts = buildMutationSql(input.values, columns);
    const tableName = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
    await sql.unsafe(`insert into ${tableName} (${parts.columnsSql}) values (${parts.valuesSql})`);
  } finally {
    await sql.close({ timeout: 0 });
  }
}

export async function updateTableRow(input: TableRowUpdateInput): Promise<void> {
  const connectionUrl = await getBranchConnectionUrl(input.branchId);

  if (!connectionUrl) {
    throw new Error(`No connection string found for ${input.branchId}`);
  }

  const sql = createSql(withDatabase(connectionUrl, input.database));

  try {
    const table = {
      schema: input.schema,
      name: input.table,
      rowEstimate: 0,
    };
    const columns = await listColumns(sql, table);
    const parts = buildMutationSql(input.values, columns);
    const tableName = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
    const result = await sql.unsafe(`update ${tableName} set ${parts.setSql} where ctid = '${escapeSqlString(input.rowId)}'::tid`);
    assertRowWasChanged(result, 'Row no longer exists');
  } finally {
    await sql.close({ timeout: 0 });
  }
}

export async function deleteTableRow(input: TableRowDeleteInput): Promise<void> {
  const connectionUrl = await getBranchConnectionUrl(input.branchId);

  if (!connectionUrl) {
    throw new Error(`No connection string found for ${input.branchId}`);
  }

  const sql = createSql(withDatabase(connectionUrl, input.database));

  try {
    const tableName = `${quoteIdentifier(input.schema)}.${quoteIdentifier(input.table)}`;
    const result = await sql.unsafe(`delete from ${tableName} where ctid = '${escapeSqlString(input.rowId)}'::tid`);
    assertRowWasChanged(result, 'Row no longer exists');
  } finally {
    await sql.close({ timeout: 0 });
  }
}

async function getBranchConnectionUrl(branchId: string): Promise<string | null> {
  if (branchId === 'prod') {
    return getSetting('prod.connectionUrl');
  }

  const branch = await getDb()
    .selectFrom('branches')
    .select('connectionUrl')
    .where('slug', '=', branchId)
    .executeTakeFirst();

  return branch?.connectionUrl || null;
}

async function listTables(sql: SQL): Promise<TableBrowserTable[]> {
  const rows = await sql<TableBrowserTable[]>`
    select
      c.table_schema as schema,
      c.table_name as name,
      coalesce(pg_class.reltuples, 0)::bigint as "rowEstimate"
    from information_schema.tables c
    left join pg_namespace on pg_namespace.nspname = c.table_schema
    left join pg_class on pg_class.relname = c.table_name
      and pg_class.relnamespace = pg_namespace.oid
    where c.table_type = 'BASE TABLE'
      and c.table_schema not in ('pg_catalog', 'information_schema')
    order by c.table_schema, c.table_name
  `;

  return rows.map(function normalizeTable(row) {
    return {
      schema: row.schema,
      name: row.name,
      rowEstimate: Math.max(0, Number(row.rowEstimate) || 0),
    };
  });
}

async function listDatabases(sql: SQL): Promise<string[]> {
  const rows = await sql<Array<{ name: string }>>`
    select datname as name
    from pg_database
    where datallowconn
      and not datistemplate
    order by datname
  `;

  return rows.map(function mapDatabase(row) {
    return row.name;
  });
}

async function getCurrentDatabase(sql: SQL): Promise<string> {
  const rows = await sql<Array<{ name: string }>>`select current_database() as name`;
  return rows[0]?.name || 'postgres';
}

async function listSchemas(sql: SQL): Promise<string[]> {
  const rows = await sql<Array<{ name: string }>>`
    select schema_name as name
    from information_schema.schemata
    where schema_name not in ('information_schema', 'pg_catalog')
      and schema_name not like 'pg_toast%'
      and schema_name not like 'pg_temp_%'
    order by schema_name
  `;

  return rows.map(function mapSchema(row) {
    return row.name;
  });
}

async function listColumns(sql: SQL, table: TableBrowserTable): Promise<TableBrowserColumn[]> {
  const rows = await sql<TableBrowserColumn[]>`
    select
      column_name as name,
      data_type as type,
      is_nullable = 'YES' as nullable,
      column_default as "defaultValue",
      ordinal_position as ordinal
    from information_schema.columns
    where table_schema = ${table.schema}
      and table_name = ${table.name}
    order by ordinal_position
  `;

  return rows.map(function normalizeColumn(row) {
    return {
      name: row.name,
      type: row.type,
      nullable: Boolean(row.nullable),
      defaultValue: row.defaultValue,
      ordinal: Number(row.ordinal),
    };
  });
}

async function countRows(sql: SQL, table: TableBrowserTable): Promise<number> {
  const tableName = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
  const rows = await sql.unsafe<Array<{ count: string | number }>>(`select count(*)::bigint as count from ${tableName}`);
  return Number(rows[0]?.count) || 0;
}

async function listRows(
  sql: SQL,
  table: TableBrowserTable,
  columns: TableBrowserColumn[],
  offset: number
): Promise<Array<Record<string, unknown>>> {
  const tableName = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
  const orderBy = columns[0] ? ` order by ${quoteIdentifier(columns[0].name)}` : '';
  const rows = await sql.unsafe<Array<Record<string, unknown>>>(
    `select *, ctid::text as ${quoteIdentifier(TABLE_ROW_ID_COLUMN)} from ${tableName}${orderBy} limit ${ROW_LIMIT} offset ${offset}`
  );
  return rows.map(function normalizeRow(row) {
    return normalizeValue(row) as Record<string, unknown>;
  });
}

function selectTable(tables: TableBrowserTable[], schema?: string, name?: string): TableBrowserTable | null {
  if (schema && name) {
    const match = tables.find(function findMatchingTable(table) {
      return table.schema === schema && table.name === name;
    });

    if (match) {
      return match;
    }
  }

  return tables[0] || null;
}

function selectDatabase(databases: string[], requested: string | undefined, current: string): string {
  if (requested && databases.includes(requested)) {
    return requested;
  }

  if (databases.includes(current)) {
    return current;
  }

  return databases[0] || current;
}

function selectSchema(schemas: string[], requested: string | undefined): string | null {
  if (requested && schemas.includes(requested)) {
    return requested;
  }

  if (schemas.includes('public')) {
    return 'public';
  }

  return schemas[0] || null;
}

function normalizeOffset(offset: number | undefined, rowCount: number): number {
  const requested = Math.max(0, offset || 0);

  if (rowCount === 0 || requested < rowCount) {
    return requested;
  }

  return Math.max(0, Math.floor((rowCount - 1) / ROW_LIMIT) * ROW_LIMIT);
}

function withDatabase(connectionUrl: string, database: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

function createSql(connectionUrl: string): SQL {
  return new SQL(connectionUrl, {
    max: 1,
    idleTimeout: 1,
  });
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function assertRowWasChanged(result: unknown, message: string): void {
  const count = typeof result === 'object' && result !== null
    ? Number((result as { count?: unknown }).count ?? 0)
    : 0;

  if (count === 0) {
    throw new Error(message);
  }
}

function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

function buildMutationSql(
  values: Record<string, string | null>,
  columns: TableBrowserColumn[]
): { columnsSql: string; valuesSql: string; setSql: string } {
  const columnByName = new Map(
    columns.map(function toEntry(column) {
      return [column.name, column] as const;
    })
  );
  const entries = Object.entries(values).filter(function keepKnownColumn([name]) {
    return name !== TABLE_ROW_ID_COLUMN && columnByName.has(name);
  });

  if (entries.length === 0) {
    throw new Error('Add at least one value');
  }

  const prepared = entries.map(function prepareValue([name, value]) {
    const column = columnByName.get(name);

    if (!column) {
      throw new Error(`Unknown column: ${name}`);
    }

    return {
      column,
      sqlValue: toTypedSqlLiteral(value, column),
    };
  });

  return {
    columnsSql: prepared.map(function getColumnSql(item) {
      return quoteIdentifier(item.column.name);
    }).join(', '),
    valuesSql: prepared.map(function getValueSql(item) {
      return item.sqlValue;
    }).join(', '),
    setSql: prepared.map(function getSetSql(item) {
      return `${quoteIdentifier(item.column.name)} = ${item.sqlValue}`;
    }).join(', '),
  };
}

function toTypedSqlLiteral(value: string | null, column: TableBrowserColumn): string {
  if (value === null) {
    return 'NULL';
  }

  const dataType = column.type.toLowerCase();
  const trimmed = value.trim();

  if (BOOLEAN_TYPES.has(dataType)) {
    if (['true', 't', '1', 'yes', 'y'].includes(trimmed.toLowerCase())) {
      return 'TRUE';
    }

    if (['false', 'f', '0', 'no', 'n'].includes(trimmed.toLowerCase())) {
      return 'FALSE';
    }

    throw new Error(`${column.name} expects boolean`);
  }

  if (INTEGER_TYPES.has(dataType)) {
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(`${column.name} expects integer`);
    }

    return trimmed;
  }

  if (NUMBER_TYPES.has(dataType)) {
    const numeric = Number(trimmed);

    if (!Number.isFinite(numeric)) {
      throw new Error(`${column.name} expects number`);
    }

    return trimmed;
  }

  if (JSON_TYPES.has(dataType)) {
    try {
      return `'${escapeSqlString(JSON.stringify(JSON.parse(value)))}'::${dataType}`;
    } catch {
      throw new Error(`${column.name} expects JSON`);
    }
  }

  if (ARRAY_TYPES.has(dataType)) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${column.name} expects JSON array`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error(`${column.name} expects JSON array`);
    }

    return `ARRAY[${parsed.map(formatArrayItem).join(', ')}]`;
  }

  return `'${escapeSqlString(value)}'`;
}

function formatArrayItem(value: unknown): string {
  if (value === null) {
    return 'NULL';
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (typeof value === 'object') {
    return `'${escapeSqlString(JSON.stringify(value))}'`;
  }

  return `'${escapeSqlString(String(value))}'`;
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Uint8Array) {
    return `<${value.byteLength} bytes>`;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(function normalizeEntry([key, item]) {
        return [key, normalizeValue(item)];
      })
    );
  }

  return value;
}
