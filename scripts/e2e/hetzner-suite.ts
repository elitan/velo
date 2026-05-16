import { SQL } from 'bun';
import { getDb } from '#db/client';
import type { Branch } from '#db/schema';
import { createApiClient } from '#api/router';
import { getSetting } from '#server/services/settings-service';
import { runCommand, runSshCommand } from '#server/services/command-service';
import { createReplicaBase } from '#server/services/replica-service';
import { runExpiredBranchCleanup } from '#server/services/branch-service';
import { TABLE_ROW_ID_COLUMN } from '#server/services/table-browser-service';
import { getContainerName, getDatasetName } from '#utils/naming';
import { isProductionBranchId, isReadOnlySql, PRODUCTION_WRITE_CONFIRMATION } from '#utils/prod-write-guard';

const api = createApiClient();
const PROJECT_NAME = 'prod';
const RUN_ID = normalizeRunId(process.env.VELO_E2E_RUN_ID || process.env.GITHUB_RUN_ID || String(Date.now()));
const PORT = process.env.VELO_PORT || '3000';
const JOB_TIMEOUT_MS = 20 * 60 * 1000;

const trackedBranches = new Set<string>();

interface TestCase {
  name: string;
  run: () => Promise<void>;
}

interface QueryResult {
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
}

async function main() {
  const tests: TestCase[] = [
    { name: 'dashboard and web smoke', run: testDashboardAndWebSmoke },
    { name: 'replica base', run: testReplicaBase },
    { name: 'branch lifecycle', run: testBranchLifecycle },
    { name: 'branch data, sql, table browser, reset', run: testBranchDataSqlTablesAndReset },
    { name: 'branch delete guard and ttl cleanup', run: testBranchDeleteGuardAndTtlCleanup },
    { name: 'production write guard', run: testProductionWriteGuard },
    { name: 'pgBackRest branch, preview, replacement PITR', run: testBranchPitrFlows },
    { name: 'production PITR restore', run: testProductionPitrRestore },
    { name: 'ready health check', run: testReadyHealthCheck },
  ];

  try {
    for (const test of tests) {
      await runTest(test);
    }
  } finally {
    await cleanupTrackedBranches();
  }
}

async function runTest(test: TestCase): Promise<void> {
  const startedAt = performance.now();
  console.log(`e2e start: ${test.name}`);
  await test.run();
  console.log(`e2e ok: ${test.name} (${Math.round(performance.now() - startedAt)}ms)`);
}

async function testDashboardAndWebSmoke(): Promise<void> {
  const state = await api.dashboard.retrieve();
  assert(state.servers.length === 2, 'expected prod and dev servers');
  assert(state.servers.every(function isOk(server) {
    return server.status === 'ok';
  }), `expected healthy servers: ${JSON.stringify(state.servers)}`);
  assert(hasDoneStep(state.setupSteps, 'dev-check'), 'dev-check should be done');
  assert(hasDoneStep(state.setupSteps, 'prod-check'), 'prod-check should be done');
  assert(hasDoneStep(state.setupSteps, 'prod-setup'), 'prod-setup should be done');
  assert(hasDoneStep(state.setupSteps, 'backups'), 'backups should be done');

  await appHead('/');
  await appHead('/settings');
}

async function testReplicaBase(): Promise<void> {
  const result = await createReplicaBase();
  assert(result.ok, result.message);

  const state = await api.dashboard.retrieve();
  assert(hasDoneStep(state.setupSteps, 'replica'), 'replica step should be done');
  const baseDataset = await getSetting('replica.baseDataset');
  assert(baseDataset, 'replica base dataset setting should be set');
  await assertZfsDatasetExists(baseDataset);
}

async function testBranchLifecycle(): Promise<void> {
  const branch = await createBranch(`e2e_life_${RUN_ID}`);

  await assertBranchConnects(branch.slug);
  await assertDockerContainerHealthy(getContainerName(PROJECT_NAME, branch.slug));
  await assertBranchPostgresPrivate(branch);
  await assertZfsDatasetExists(branch.dataset);

  await deleteBranchBySlug(branch.slug);
  await assertBranchMissing(branch.slug);
  await assertDockerContainerMissing(getContainerName(PROJECT_NAME, branch.slug));
  await assertZfsDatasetMissing(branch.dataset);
}

async function testBranchDataSqlTablesAndReset(): Promise<void> {
  const parent = await createBranch(`e2e_parent_${RUN_ID}`);
  const table = `e2e_items_${RUN_ID}`;
  const browserTable = `e2e_browser_${RUN_ID}`;

  await runBranchSql(parent.slug, [
    `create table ${table} (id integer primary key, note text not null)`,
    `insert into ${table} (id, note) values (1, 'parent')`,
  ].join('; '));

  const parentRows = await runBranchSql(parent.slug, `select note from ${table} order by id`);
  assertSingleValue(parentRows, 'note', 'parent');

  const child = await createBranch(`e2e_child_${RUN_ID}`, parent.id);
  const childRows = await runBranchSql(child.slug, `select note from ${table} order by id`);
  assertSingleValue(childRows, 'note', 'parent');

  await runBranchSql(child.slug, [
    `update ${table} set note = 'child' where id = 1`,
    `insert into ${table} (id, note) values (2, 'child-only')`,
  ].join('; '));

  const changedChildRows = await runBranchSql(child.slug, `select note from ${table} order by id`);
  assert(changedChildRows.rows.map(function getNote(row) {
    return row.note;
  }).join(',') === 'child,child-only', 'child should have isolated data');

  const unchangedParentRows = await runBranchSql(parent.slug, `select note from ${table} order by id`);
  assertSingleValue(unchangedParentRows, 'note', 'parent');

  await assertSqlError(child.slug, 'select * from table_that_should_not_exist');

  await runBranchSql(child.slug, [
    `create table ${browserTable} (id integer primary key, note text not null, active boolean not null default true)`,
    `insert into ${browserTable} (id, note, active) values (1, 'from sql', true)`,
  ].join('; '));

  const metadata = await api.tables.browse({ branchId: child.slug, schema: 'public', table: browserTable });
  assert(metadata.selectedTable?.name === browserTable, 'table browser should select created table');

  await api.tables.insert({
    branchId: child.slug,
    database: metadata.selectedDatabase,
    schema: 'public',
    table: browserTable,
    values: { id: '2', note: 'inserted', active: 'false' },
  });

  let rows = await api.tables.rows({
    branchId: child.slug,
    database: metadata.selectedDatabase,
    schema: 'public',
    table: browserTable,
  });
  assert(rows.rowCount === 2, `expected two table browser rows: ${JSON.stringify(rows.rows)}`);

  const inserted = rows.rows.find(function findInserted(row) {
    return row.note === 'inserted';
  });
  assert(inserted, 'inserted row should be visible');
  const rowId = inserted[TABLE_ROW_ID_COLUMN];
  assert(typeof rowId === 'string', 'inserted row should expose ctid');

  await api.tables.update({
    branchId: child.slug,
    database: metadata.selectedDatabase,
    schema: 'public',
    table: browserTable,
    rowId,
    values: { note: 'updated', active: 'true' },
  });

  rows = await api.tables.rows({
    branchId: child.slug,
    database: metadata.selectedDatabase,
    schema: 'public',
    table: browserTable,
  });
  const updated = rows.rows.find(function findUpdated(row) {
    return row.note === 'updated';
  });
  assert(updated?.active === true, 'updated row should be active');
  const updatedRowId = updated[TABLE_ROW_ID_COLUMN];
  assert(typeof updatedRowId === 'string', 'updated row should expose ctid');

  await api.tables.delete({
    branchId: child.slug,
    database: metadata.selectedDatabase,
    schema: 'public',
    table: browserTable,
    rowId: updatedRowId,
  });

  rows = await api.tables.rows({
    branchId: child.slug,
    database: metadata.selectedDatabase,
    schema: 'public',
    table: browserTable,
  });
  assert(rows.rowCount === 1, 'delete should leave one row');

  await waitForJob((await api.branches.reset({ id: child.id })).id, JOB_TIMEOUT_MS);
  const resetRows = await runBranchSql(child.slug, `select note from ${table} order by id`);
  assertSingleValue(resetRows, 'note', 'parent');
  await assertSqlError(child.slug, `select * from ${browserTable}`);
}

async function testBranchDeleteGuardAndTtlCleanup(): Promise<void> {
  const parent = await createBranch(`e2e_guard_parent_${RUN_ID}`);
  const child = await createBranch(`e2e_guard_child_${RUN_ID}`, parent.id);

  const deleteJob = await api.branches.delete({ id: parent.id });
  await assertJobFails(deleteJob.id, 'Branch has child branches');
  await assertBranchConnects(parent.slug);
  await assertBranchConnects(child.slug);

  await deleteBranchBySlug(child.slug);
  await deleteBranchBySlug(parent.slug);

  const expired = await createBranch(`e2e_ttl_${RUN_ID}`, null, new Date(Date.now() - 60_000).toISOString());
  await runExpiredBranchCleanup();
  await waitForBranchCleanup(expired.id, JOB_TIMEOUT_MS);
  trackedBranches.delete(expired.slug);
  await assertDockerContainerMissing(getContainerName(PROJECT_NAME, expired.slug));
  await assertZfsDatasetMissing(expired.dataset);
}

async function testProductionWriteGuard(): Promise<void> {
  const table = `e2e_prod_guard_${RUN_ID}`;

  const read = await runBranchSqlRaw('production', 'select 1 as ok');
  assertSingleValue(read, 'ok', 1);
  await assertSqlErrorRaw('production', `create table ${table} (id integer primary key)`);
  await assertProdWriteAudit(false, `create table ${table}`);

  await runBranchSqlRaw(
    'production',
    `create table ${table} (id integer primary key); drop table ${table}`,
    PRODUCTION_WRITE_CONFIRMATION
  );
  await assertProdWriteAudit(true, `create table ${table}`);
}

async function testBranchPitrFlows(): Promise<void> {
  const table = `e2e_pitr_${RUN_ID}`;
  const branchName = `e2e_pitr_${RUN_ID}`;
  const previewWriteTable = `e2e_preview_write_${RUN_ID}`;
  const replaceName = `e2e_replace_${RUN_ID}`;
  const targetTime = await preparePitrFixture(table);

  await syncProdBackupRepoToApp();
  trackedBranches.add(branchName);
  trackedBranches.add(replaceName);

  const job = await api.branches.restore({
    targetBranch: branchName,
    sourceBranch: 'production',
    restoreTime: targetTime,
  });
  await waitForJob(job.id, JOB_TIMEOUT_MS);

  const branch = await getBranch(branchName);
  await assertBranchPostgresPrivate(branch);

  const rows = await runBranchSql(branchName, `select label from ${table} order by id`);
  assert(rows.rows.map(function getLabel(row) {
    return row.label;
  }).join(',') === 'before', `PITR branch should restore before row only: ${JSON.stringify(rows.rows)}`);

  const preview = await api.branches.preview.create({
    sourceBranch: 'production',
    restoreTime: targetTime,
  });
  trackedBranches.add(preview.slug);
  const previewRows = await runBranchSql(preview.slug, `select label from ${table} order by id`);
  assert(previewRows.rows.map(function getLabel(row) {
    return row.label;
  }).join(',') === 'before', `PITR preview should restore before row only: ${JSON.stringify(previewRows.rows)}`);
  await assertSqlError(preview.slug, `create table ${previewWriteTable} (id integer primary key)`);
  await waitForJob((await api.branches.preview.delete({ id: preview.id })).id, JOB_TIMEOUT_MS);
  trackedBranches.delete(preview.slug);
  await assertBranchMissing(preview.slug);
  await assertZfsDatasetMissing(getDatasetName(PROJECT_NAME, preview.slug));

  const replacement = await createBranch(replaceName);
  const oldId = replacement.id;
  const oldDataset = replacement.dataset;
  await runBranchSql(replaceName, `create table e2e_local_marker_${RUN_ID} (id integer primary key)`);

  const replaceJob = await api.branches.restore({
    targetBranch: replaceName,
    sourceBranch: 'production',
    restoreTime: targetTime,
  });
  await waitForJob(replaceJob.id, JOB_TIMEOUT_MS);

  const replaced = await getBranch(replaceName);
  assert(replaced.id === oldId, 'replacement restore should preserve branch id');
  assert(replaced.dataset !== oldDataset, 'replacement restore should swap branch dataset');
  await assertBranchConnects(replaceName);
  await assertZfsDatasetMissing(oldDataset);
  await assertSqlError(replaceName, `select * from e2e_local_marker_${RUN_ID}`);
  const replacedRows = await runBranchSql(replaceName, `select label from ${table} order by id`);
  assert(replacedRows.rows.map(function getLabel(row) {
    return row.label;
  }).join(',') === 'before', `replacement PITR branch should restore before row only: ${JSON.stringify(replacedRows.rows)}`);
}

async function testProductionPitrRestore(): Promise<void> {
  const table = `e2e_prod_pitr_${RUN_ID}`;
  const targetTime = await preparePitrFixture(table);
  const blockedBranchName = `e2e_stale_block_${RUN_ID}`;
  const rebuiltBranchName = `e2e_after_rebuild_${RUN_ID}`;

  const job = await api.branches.restore({
    targetBranch: 'production',
    sourceBranch: 'production',
    restoreTime: targetTime,
    productionRestoreConfirmation: 'restore production',
  });
  await waitForJob(job.id, JOB_TIMEOUT_MS);

  await appHead('/');
  const rows = await runBranchSql('production', `select label from ${table} order by id`);
  assert(rows.rows.map(function getLabel(row) {
    return row.label;
  }).join(',') === 'before', `production restore should keep before row only: ${JSON.stringify(rows.rows)}`);

  const staleState = await api.dashboard.retrieve();
  assert(hasStepStatus(staleState.setupSteps, 'replica', 'stale'), 'production restore should mark replica base stale');

  await assertBranchCreateFails(blockedBranchName, 'Production was restored. Rebuild the dev replica before creating a branch');

  const rebuild = await createReplicaBase();
  assert(rebuild.ok, rebuild.message);

  const rebuiltState = await api.dashboard.retrieve();
  assert(hasDoneStep(rebuiltState.setupSteps, 'replica'), 'replica step should be done after rebuild');

  await createBranch(rebuiltBranchName);
}

async function testReadyHealthCheck(): Promise<void> {
  const command = [
    'set -e',
    `curl -fsS ${shellQuote(`http://127.0.0.1:${PORT}/healthz?ready=1`)}`,
  ].join('\n');
  const result = await runCommand(['sh', '-lc', command], 30000);
  await assertCommandOk(result, 'ready health check');
  const health = JSON.parse(result.stdout) as { ok?: boolean };
  assert(health.ok === true, `ready health should be ok: ${result.stdout}`);
}

async function preparePitrFixture(table: string): Promise<string> {
  await runBranchSql('production', [
    `drop table if exists ${table}`,
    `create table ${table} (id integer primary key, label text not null)`,
    `insert into ${table} (id, label) values (1, 'before')`,
  ].join('; '));

  const target = await prodScalar("select (clock_timestamp() + interval '1 second')::timestamptz as target", 'target');
  await sleep(1500);
  await runBranchSql('production', 'select pg_switch_wal()');
  await sleep(1500);

  await runBranchSql('production', `insert into ${table} (id, label) values (2, 'after')`);
  await runBranchSql('production', 'select pg_switch_wal()');
  await waitForProdArchive();

  return new Date(String(target)).toISOString();
}

async function createBranch(name: string, parentBranchId?: number | null, expiresAt?: string | null): Promise<Branch> {
  const result = await api.branches.create({ name, parentBranchId, expiresAt });
  trackedBranches.add(result.branchSlug);
  await waitForJob(result.id, JOB_TIMEOUT_MS);
  return getBranch(result.branchSlug);
}

async function deleteBranchBySlug(slug: string): Promise<void> {
  const branch = await findBranch(slug);

  if (!branch) {
    trackedBranches.delete(slug);
    return;
  }

  const job = await api.branches.delete({ id: branch.id });
  await waitForJob(job.id, JOB_TIMEOUT_MS);
  trackedBranches.delete(slug);
}

async function cleanupTrackedBranches(): Promise<void> {
  const branches = Array.from(trackedBranches).reverse();

  for (const slug of branches) {
    try {
      await deleteBranchBySlug(slug);
    } catch (error: any) {
      console.error(`cleanup failed for ${slug}: ${error?.message || String(error)}`);
    }
  }
}

async function waitForJob(jobId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest: Awaited<ReturnType<typeof api.jobs.retrieve>> | null = null;

  while (Date.now() < deadline) {
    latest = await api.jobs.retrieve({ id: jobId });

    if (latest.status === 'done') {
      return;
    }

    if (latest.status === 'error') {
      throw new Error(`job ${jobId} failed: ${latest.error || JSON.stringify(latest.logs)}`);
    }

    await sleep(1500);
  }

  throw new Error(`job ${jobId} timed out: ${JSON.stringify(latest)}`);
}

async function assertJobFails(jobId: number, expectedMessage: string): Promise<void> {
  try {
    await waitForJob(jobId, JOB_TIMEOUT_MS);
  } catch (error: any) {
    assert(String(error?.message || error).includes(expectedMessage), `expected job ${jobId} to fail with ${expectedMessage}`);
    return;
  }

  throw new Error(`expected job ${jobId} to fail`);
}

async function waitForBranchCleanup(branchId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const branch = await getDb()
      .selectFrom('branches')
      .select(['id'])
      .where('id', '=', branchId)
      .executeTakeFirst();

    if (!branch) {
      return;
    }

    const jobs = await api.jobs.list({ limit: 20, type: 'branch-cleanup' });
    const failed = jobs.find(function isFailedCleanup(job) {
      return job.status === 'error' && getJobInputBranchId(job.input) === branchId;
    });

    if (failed) {
      throw new Error(`branch cleanup ${failed.id} failed: ${failed.error}`);
    }

    await sleep(1500);
  }

  throw new Error(`branch cleanup timed out for ${branchId}`);
}

async function runBranchSql(branchId: string, sql: string): Promise<QueryResult> {
  return runBranchSqlRaw(
    branchId,
    sql,
    isProductionBranchId(branchId) && !isReadOnlySql(sql)
      ? PRODUCTION_WRITE_CONFIRMATION
      : undefined
  );
}

async function runBranchSqlRaw(branchId: string, sql: string, productionWriteConfirmation?: string): Promise<QueryResult> {
  return api.branches.sql.run({
    branchId,
    sql,
    productionWriteConfirmation,
  });
}

async function assertSqlErrorRaw(branchId: string, sql: string): Promise<void> {
  try {
    await runBranchSqlRaw(branchId, sql);
  } catch {
    return;
  }

  throw new Error(`expected SQL to fail: ${sql}`);
}

async function assertProdWriteAudit(allowed: boolean, targetPrefix: string): Promise<void> {
  const jobs = await api.jobs.list({ limit: 20, type: 'prod-write-attempt' });
  const audit = jobs.find(function isMatchingAudit(job) {
    const input = job.input as Record<string, unknown> | null;
    return input?.allowed === allowed
      && typeof input.target === 'string'
      && input.target.startsWith(targetPrefix);
  });

  assert(audit, `expected production write audit allowed=${String(allowed)} target=${targetPrefix}`);
}

async function assertSqlError(branchId: string, sql: string): Promise<void> {
  try {
    await runBranchSql(branchId, sql);
  } catch {
    return;
  }

  throw new Error(`expected SQL to fail: ${sql}`);
}

async function assertBranchConnects(slug: string): Promise<void> {
  const result = await runBranchSql(slug, 'select 1 as ok');
  assertSingleValue(result, 'ok', 1);
}

async function prodScalar(sql: string, column: string): Promise<unknown> {
  const connectionUrl = await getSetting('prod.connectionUrl');
  assert(connectionUrl, 'prod connection URL is missing');
  const client = new SQL({ url: connectionUrl, max: 1 });

  try {
    const rows = await client.unsafe<Array<Record<string, unknown>>>(sql);
    return rows[0]?.[column];
  } finally {
    await client.close();
  }
}

async function syncProdBackupRepoToApp(): Promise<void> {
  const prod = await getDb()
    .selectFrom('servers')
    .selectAll()
    .where('role', '=', 'prod')
    .executeTakeFirstOrThrow();

  await assertCommandOk(await runCommand([
    'sh',
    '-lc',
    [
      'set -e',
      'rm -rf /var/lib/pgbackrest',
      `ssh -i ${shellQuote(prod.sshKeyPath)} -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 ${shellQuote(`${prod.sshUser}@${prod.host}`)} ${shellQuote('sudo tar -C /var/lib -cf - pgbackrest')} | tar -C /var/lib -xf -`,
      'chmod -R a+rX /var/lib/pgbackrest',
      'pgbackrest --stanza=main info --output=json >/dev/null',
    ].join('\n'),
  ], 5 * 60 * 1000), 'sync prod pgBackRest repo');
}

async function waitForProdArchive(): Promise<void> {
  const prod = await getDb()
    .selectFrom('servers')
    .selectAll()
    .where('role', '=', 'prod')
    .executeTakeFirstOrThrow();

  await assertCommandOk(await runSshCommand({
    host: prod.host,
    user: prod.sshUser,
    keyPath: prod.sshKeyPath,
  }, 'sudo -u postgres pgbackrest --stanza=main check', 2 * 60 * 1000), 'prod pgBackRest archive check');
}

async function appHead(path: string): Promise<void> {
  const command = [
    'set -e',
    `curl -fsS -I ${shellQuote(`http://127.0.0.1:${PORT}${path}`)} >/dev/null`,
  ].join('\n');

  await assertCommandOk(await runCommand(['sh', '-lc', command], 30000), `HEAD ${path}`);
}

async function assertDockerContainerHealthy(containerName: string): Promise<void> {
  const result = await runCommand([
    'docker',
    'inspect',
    '--format',
    '{{.State.Status}}',
    containerName,
  ]);

  await assertCommandOk(result, `docker inspect ${containerName}`);
  assert(result.stdout === 'running', `${containerName} should be running, got ${result.stdout}`);
}

async function assertDockerContainerMissing(containerName: string): Promise<void> {
  const result = await runCommand(['docker', 'inspect', containerName]);
  assert(result.exitCode !== 0, `${containerName} should be deleted`);
}

async function assertBranchPostgresPrivate(branch: Branch): Promise<void> {
  const host = branch.connectionUrl ? new URL(branch.connectionUrl).hostname : null;
  assert(host === 'localhost', `branch connection URL should use localhost, got ${host}`);

  const result = await runCommand([
    'docker',
    'inspect',
    '--format',
    '{{range (index .NetworkSettings.Ports "5432/tcp")}}{{.HostIp}}{{end}}',
    getContainerName(PROJECT_NAME, branch.slug),
  ]);

  await assertCommandOk(result, `docker inspect branch port ${branch.slug}`);
  assert(result.stdout === '127.0.0.1', `${branch.slug} Postgres should bind localhost, got ${result.stdout}`);

  await assertBranchPostgresRejectsBadPassword(branch);
}

async function assertBranchPostgresRejectsBadPassword(branch: Branch): Promise<void> {
  assert(branch.connectionUrl, `${branch.slug} connection URL should be set`);
  const url = new URL(branch.connectionUrl);
  url.password = `wrong-${RUN_ID}`;

  const result = await runCommand([
    'psql',
    url.toString(),
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    'select 1',
  ], 30000);

  assert(result.exitCode !== 0, `${branch.slug} PostgreSQL should reject bad password`);
}

async function assertZfsDatasetExists(dataset: string): Promise<void> {
  await assertCommandOk(await runCommand(['zfs', 'list', `tank/velo/databases/${dataset}`]), `zfs list ${dataset}`);
}

async function assertZfsDatasetMissing(dataset: string): Promise<void> {
  const result = await runCommand(['zfs', 'list', `tank/velo/databases/${dataset}`]);
  assert(result.exitCode !== 0, `${dataset} ZFS dataset should be deleted`);
}

async function getBranch(slug: string): Promise<Branch> {
  const branch = await findBranch(slug);
  assert(branch, `branch missing: ${slug}`);
  return branch;
}

async function findBranch(slug: string): Promise<Branch | undefined> {
  return getDb()
    .selectFrom('branches')
    .selectAll()
    .where('slug', '=', slug)
    .executeTakeFirst();
}

async function assertBranchMissing(slug: string): Promise<void> {
  const branch = await findBranch(slug);
  assert(!branch, `branch should be deleted: ${slug}`);
}

async function assertCommandOk(result: { exitCode: number; stdout: string; stderr: string }, label: string): Promise<void> {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  }
}

function assertSingleValue(result: QueryResult, column: string, expected: string | number | boolean | null): void {
  assert(result.rows.length === 1, `expected one row: ${JSON.stringify(result.rows)}`);
  assert(result.rows[0]?.[column] === expected, `expected ${String(expected)} for ${column}: ${JSON.stringify(result.rows)}`);
}

function hasDoneStep(steps: Array<{ key: string; status: string }>, key: string): boolean {
  return hasStepStatus(steps, key, 'done');
}

function hasStepStatus(steps: Array<{ key: string; status: string }>, key: string, status: string): boolean {
  return steps.some(function hasMatchingStep(step) {
    return step.key === key && step.status === status;
  });
}

function getJobInputBranchId(input: unknown): number | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const value = (input as Record<string, unknown>).branchId;
  return typeof value === 'number' ? value : null;
}

async function assertBranchCreateFails(name: string, expectedMessage: string): Promise<void> {
  const job = await api.branches.create({ name });

  try {
    await waitForJob(job.id, JOB_TIMEOUT_MS);
  } catch (error: any) {
    assert(String(error?.message || error).includes(expectedMessage), `expected branch create to fail with ${expectedMessage}`);
    return;
  }

  throw new Error(`expected branch create to fail: ${name}`);
}

function assert(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(function wait(resolve) {
    setTimeout(resolve, ms);
  });
}

function normalizeRunId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-10);
  return normalized || String(Date.now()).slice(-10);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

main().catch(async function handleError(error) {
  console.error(error?.stack || error?.message || String(error));
  await printDebugState().catch(function ignoreDebugError(debugError) {
    console.error(debugError?.message || String(debugError));
  });
  process.exit(1);
});

async function printDebugState(): Promise<void> {
  console.error('e2e debug: branches');
  console.error(JSON.stringify(await getDb().selectFrom('branches').selectAll().execute(), null, 2));
  console.error('e2e debug: recent jobs');
  console.error(JSON.stringify(await api.jobs.list(), null, 2));
  console.error('e2e debug: docker');
  console.error((await runCommand(['docker', 'ps', '-a'])).stdout);
  console.error('e2e debug: zfs');
  console.error((await runCommand(['zfs', 'list', '-r', 'tank/velo/databases'])).stdout);

  const prod = await getDb()
    .selectFrom('servers')
    .selectAll()
    .where('role', '=', 'prod')
    .executeTakeFirst();

  if (prod) {
    const result = await runSshCommand({
      host: prod.host,
      user: prod.sshUser,
      keyPath: prod.sshKeyPath,
    }, 'systemctl status postgresql --no-pager -l || true; sudo -u postgres pgbackrest --stanza=main info || true', 30000);
    console.error('e2e debug: prod');
    console.error(result.stdout || result.stderr);
  }
}
