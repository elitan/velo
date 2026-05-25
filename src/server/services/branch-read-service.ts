import { getDb } from '#db/client';

export interface BranchRecord {
  id: number;
  slug: string;
  displayName: string;
  status: string;
  parentBranchId: number | null;
  parentName: string | null;
  parentSlug: string | null;
  port: number | null;
  connectionUrl: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export async function listBranchRecords(): Promise<BranchRecord[]> {
  return selectBranchRecords()
    .where('branches.slug', 'not like', 'preview-%')
    .orderBy('branches.createdAt', 'desc')
    .execute();
}

export async function getBranchRecord(slug: string): Promise<BranchRecord> {
  const branch = await findBranchRecord(slug);

  if (!branch) {
    throw new Error(`Branch not found: ${slug}`);
  }

  return branch;
}

export async function findBranchRecord(slug: string): Promise<BranchRecord | null> {
  const branch = await selectBranchRecords()
    .where('branches.slug', '=', slug)
    .executeTakeFirst();

  return branch ?? null;
}

export async function branchSlugExists(slug: string): Promise<boolean> {
  const branch = await getDb()
    .selectFrom('branches')
    .select('id')
    .where('slug', '=', slug)
    .executeTakeFirst();

  return Boolean(branch);
}

function selectBranchRecords() {
  return getDb()
    .selectFrom('branches')
    .leftJoin('branches as parent', 'parent.id', 'branches.parentBranchId')
    .select([
      'branches.id',
      'branches.slug',
      'branches.displayName',
      'branches.status',
      'branches.parentBranchId',
      'parent.displayName as parentName',
      'parent.slug as parentSlug',
      'branches.port',
      'branches.connectionUrl',
      'branches.expiresAt',
      'branches.createdAt',
    ]);
}
