import { getDb } from '#db/client';
import { getSetting } from './settings-service';
import {
  createBranchFromBase,
  deleteBranch,
  normalizeBranchSlug,
  resetBranchFromParent,
  updateBranchExpiry,
} from './branch-service';
import { getReplicaFreshness } from './replica-service';
import { getReplicaBranchCreatePolicy, type ReplicaBranchCreatePolicy } from '#utils/replica-freshness-policy';
import type { branchCreateInput } from '#api/branch-contract';
import type { z } from 'zod';

type CreateBranchApiInput = z.infer<typeof branchCreateInput>;

export interface BranchApiRecord {
  id: string;
  slug: string;
  name: string;
  type: 'production' | 'development';
  status: string;
  parent: {
    slug: string;
    name: string;
  } | null;
  createdAt: string | null;
  expiresAt: string | null;
  connectionUri: string | null;
}

export async function listBranchesApi(): Promise<{ branches: BranchApiRecord[] }> {
  const [production, branches] = await Promise.all([
    getProductionBranchApiRecord(),
    listDevelopmentBranchRows(),
  ]);

  return {
    branches: [
      production,
      ...branches.map(mapDevelopmentBranchRow),
    ],
  };
}

export async function getBranchApi(slug: string): Promise<{ branch: BranchApiRecord }> {
  const normalized = normalizeBranchLookup(slug);

  if (normalized === 'production') {
    return { branch: await getProductionBranchApiRecord() };
  }

  return {
    branch: mapDevelopmentBranchRow(await getDevelopmentBranchRow(normalized)),
  };
}

export async function createBranchApi(input: CreateBranchApiInput): Promise<{
  branch: BranchApiRecord;
  connectionUri: string;
  replicaWarning: string | null;
}> {
  const branchSlug = normalizeBranchSlug(input.name);
  await assertBranchSlugAvailable(branchSlug);
  const parentBranchId = await resolveParentBranchId(input.parent);
  const replicaPolicy = await assertReplicaCreateAllowed(parentBranchId, Boolean(input.forceReplicaStale));

  await createBranchFromBase({
    name: input.name,
    slug: branchSlug,
    parentBranchId,
    ttlHours: input.ttlHours,
    expiresAt: input.expiresAt,
    forceReplicaStale: input.forceReplicaStale,
  });

  const branch = mapDevelopmentBranchRow(await getDevelopmentBranchRow(branchSlug));

  if (!branch.connectionUri) {
    throw new Error('Branch connection URI is missing');
  }

  return {
    branch,
    connectionUri: branch.connectionUri,
    replicaWarning: replicaPolicy.status === 'warn' ? formatReplicaWarning(replicaPolicy) : null,
  };
}

export async function deleteBranchApi(slug: string): Promise<{
  deleted: true;
  branch: {
    id: string;
    slug: string;
    name: string;
  };
}> {
  const normalized = normalizeDevelopmentBranchLookup(slug);
  const branch = await getDevelopmentBranchRow(normalized);
  const result = await deleteBranch({ id: branch.rowId });

  return {
    deleted: true,
    branch: {
      id: result.slug,
      slug: result.slug,
      name: result.displayName,
    },
  };
}

export async function resetBranchApi(slug: string): Promise<{
  branch: BranchApiRecord;
  connectionUri: string;
}> {
  const normalized = normalizeDevelopmentBranchLookup(slug);
  const branch = await getDevelopmentBranchRow(normalized);
  await resetBranchFromParent({ id: branch.rowId });

  const updated = mapDevelopmentBranchRow(await getDevelopmentBranchRow(normalized));

  if (!updated.connectionUri) {
    throw new Error('Branch connection URI is missing');
  }

  return {
    branch: updated,
    connectionUri: updated.connectionUri,
  };
}

export async function updateBranchExpiryApi(input: {
  slug: string;
  expiresAt: string | null;
}): Promise<{ branch: BranchApiRecord }> {
  const normalized = normalizeDevelopmentBranchLookup(input.slug);
  const branch = await getDevelopmentBranchRow(normalized);

  await updateBranchExpiry({
    id: branch.rowId,
    expiresAt: input.expiresAt,
  });

  return {
    branch: mapDevelopmentBranchRow(await getDevelopmentBranchRow(normalized)),
  };
}

async function getProductionBranchApiRecord(): Promise<BranchApiRecord> {
  return {
    id: 'production',
    slug: 'production',
    name: 'production',
    type: 'production',
    status: await getSetting('prod.connectionUrl') ? 'ready' : 'pending',
    parent: null,
    createdAt: null,
    expiresAt: null,
    connectionUri: await getSetting('prod.connectionUrl'),
  };
}

async function listDevelopmentBranchRows(): Promise<DevelopmentBranchRow[]> {
  return getDb()
    .selectFrom('branches')
    .leftJoin('branches as parent', 'parent.id', 'branches.parentBranchId')
    .select([
      'branches.id as rowId',
      'branches.slug',
      'branches.displayName',
      'branches.status',
      'branches.connectionUrl',
      'branches.expiresAt',
      'branches.createdAt',
      'parent.slug as parentSlug',
      'parent.displayName as parentName',
    ])
    .where('branches.slug', 'not like', 'preview-%')
    .orderBy('branches.createdAt', 'desc')
    .execute();
}

async function getDevelopmentBranchRow(slug: string): Promise<DevelopmentBranchRow> {
  const branch = await getDb()
    .selectFrom('branches')
    .leftJoin('branches as parent', 'parent.id', 'branches.parentBranchId')
    .select([
      'branches.id as rowId',
      'branches.slug',
      'branches.displayName',
      'branches.status',
      'branches.connectionUrl',
      'branches.expiresAt',
      'branches.createdAt',
      'parent.slug as parentSlug',
      'parent.displayName as parentName',
    ])
    .where('branches.slug', '=', slug)
    .executeTakeFirst();

  if (!branch) {
    throw new Error(`Branch not found: ${slug}`);
  }

  return branch;
}

async function resolveParentBranchId(parent: string | null | undefined): Promise<number | null> {
  const normalized = normalizeBranchLookup(parent || 'production');

  if (normalized === 'production') {
    return null;
  }

  const branch = await getDb()
    .selectFrom('branches')
    .select(['id'])
    .where('slug', '=', normalized)
    .executeTakeFirst();

  if (!branch) {
    throw new Error(`Parent branch not found: ${normalized}`);
  }

  return branch.id;
}

async function assertBranchSlugAvailable(branchSlug: string): Promise<void> {
  const existingBranch = await getDb()
    .selectFrom('branches')
    .select('id')
    .where('slug', '=', branchSlug)
    .executeTakeFirst();

  if (existingBranch) {
    throwDuplicateBranch(branchSlug);
  }

  const activeCreateJobs = await getDb()
    .selectFrom('jobs')
    .select(['inputJson'])
    .where('type', '=', 'create-branch')
    .where('status', 'in', ['queued', 'running'])
    .execute();

  const hasActiveCreate = activeCreateJobs.some(function hasMatchingCreateJob(job) {
    return getCreateBranchSlug(job.inputJson) === branchSlug;
  });

  if (hasActiveCreate) {
    throwDuplicateBranch(branchSlug);
  }
}

async function assertReplicaCreateAllowed(parentBranchId: number | null, forced: boolean): Promise<ReplicaBranchCreatePolicy> {
  if (parentBranchId) {
    return { status: 'allow', lagMs: null };
  }

  const policy = getReplicaBranchCreatePolicy(await getReplicaFreshness());

  if (policy.status === 'block' && !forced) {
    throw new Error(formatReplicaBlock(policy));
  }

  return policy;
}

function mapDevelopmentBranchRow(row: DevelopmentBranchRow): BranchApiRecord {
  return {
    id: row.slug,
    slug: row.slug,
    name: row.displayName,
    type: 'development',
    status: row.status,
    parent: {
      slug: row.parentSlug || 'production',
      name: row.parentName || 'production',
    },
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    connectionUri: row.connectionUrl,
  };
}

function normalizeBranchLookup(slug: string): string {
  const normalized = slug.trim().toLowerCase();

  if (normalized === 'production' || normalized === 'prod') {
    return 'production';
  }

  return normalizeBranchSlug(normalized);
}

function normalizeDevelopmentBranchLookup(slug: string): string {
  const normalized = normalizeBranchLookup(slug);

  if (normalized === 'production') {
    throw new Error('Production cannot be changed here');
  }

  return normalized;
}

function getCreateBranchSlug(inputJson: string | null): string | null {
  if (!inputJson) {
    return null;
  }

  try {
    const input = JSON.parse(inputJson) as { name?: unknown };

    if (typeof input.name !== 'string') {
      return null;
    }

    return normalizeBranchSlug(input.name);
  } catch {
    return null;
  }
}

function formatReplicaWarning(policy: ReplicaBranchCreatePolicy): string {
  return `Dev replica is ${formatDuration(policy.lagMs ?? 0)} behind production. Branch may start stale.`;
}

function formatReplicaBlock(policy: ReplicaBranchCreatePolicy): string {
  if (policy.lagMs === null) {
    return 'Dev replica freshness is unknown. Refresh the replica or force branch creation.';
  }

  return `Dev replica is ${formatDuration(policy.lagMs)} behind production. Force branch creation to use stale production state.`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);

  return `${hours}h`;
}

function throwDuplicateBranch(branchSlug: string): never {
  throw new Error(`Branch already exists: ${branchSlug}`);
}

interface DevelopmentBranchRow {
  rowId: number;
  slug: string;
  displayName: string;
  status: string;
  connectionUrl: string | null;
  expiresAt: string | null;
  createdAt: string;
  parentSlug: string | null;
  parentName: string | null;
}
