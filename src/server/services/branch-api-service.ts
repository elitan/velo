import { getSetting } from './settings-service';
import {
  createBranchFromBase,
  deleteBranch,
  normalizeBranchSlug,
  resetBranchFromParent,
  updateBranchExpiry,
} from './branch-service';
import { getReplicaFreshness } from './replica-service';
import { branchSlugExists, findBranchRecord, getBranchRecord, listBranchRecords, type BranchRecord } from './branch-read-service';
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
  connectionString: string | null;
}

export async function listBranchesApi(): Promise<{ branches: BranchApiRecord[] }> {
  const [production, branches] = await Promise.all([
    getProductionBranchApiRecord(),
    listBranchRecords(),
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
    branch: mapDevelopmentBranchRow(await getBranchRecord(normalized)),
  };
}

export async function createBranchApi(input: CreateBranchApiInput): Promise<{
  branch: BranchApiRecord;
  connectionString: string;
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

  const branch = mapDevelopmentBranchRow(await getBranchRecord(branchSlug));

  if (!branch.connectionString) {
    throw new Error('Branch connection string is missing');
  }

  return {
    branch,
    connectionString: branch.connectionString,
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
  const branch = await getBranchRecord(normalized);
  const result = await deleteBranch({ id: branch.id });

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
  connectionString: string;
}> {
  const normalized = normalizeDevelopmentBranchLookup(slug);
  const branch = await getBranchRecord(normalized);
  await resetBranchFromParent({ id: branch.id });

  const updated = mapDevelopmentBranchRow(await getBranchRecord(normalized));

  if (!updated.connectionString) {
    throw new Error('Branch connection string is missing');
  }

  return {
    branch: updated,
    connectionString: updated.connectionString,
  };
}

export async function updateBranchExpiryApi(input: {
  slug: string;
  expiresAt: string | null;
}): Promise<{ branch: BranchApiRecord }> {
  const normalized = normalizeDevelopmentBranchLookup(input.slug);
  const branch = await getBranchRecord(normalized);

  await updateBranchExpiry({
    id: branch.id,
    expiresAt: input.expiresAt,
  });

  return {
    branch: mapDevelopmentBranchRow(await getBranchRecord(normalized)),
  };
}

async function getProductionBranchApiRecord(): Promise<BranchApiRecord> {
  const connectionString = await getSetting('prod.connectionUrl');

  return {
    id: 'production',
    slug: 'production',
    name: 'production',
    type: 'production',
    status: connectionString ? 'ready' : 'pending',
    parent: null,
    createdAt: null,
    expiresAt: null,
    connectionString,
  };
}

async function resolveParentBranchId(parent: string | null | undefined): Promise<number | null> {
  const normalized = normalizeBranchLookup(parent || 'production');

  if (normalized === 'production') {
    return null;
  }

  const branch = await findBranchRecord(normalized);

  if (!branch) {
    throw new Error(`Parent branch not found: ${normalized}`);
  }

  return branch.id;
}

async function assertBranchSlugAvailable(branchSlug: string): Promise<void> {
  if (await branchSlugExists(branchSlug)) {
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

function mapDevelopmentBranchRow(row: BranchRecord): BranchApiRecord {
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
    connectionString: row.connectionUrl,
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
