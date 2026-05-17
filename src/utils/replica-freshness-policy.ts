export const REPLICA_BRANCH_WARN_MS = 10_000;
export const REPLICA_BRANCH_BLOCK_MS = 60_000;

export type ReplicaBranchCreateStatus = 'allow' | 'warn' | 'block';

export interface ReplicaBranchFreshness {
  lagMs: number | null;
  byteLag?: number | null;
}

export interface ReplicaBranchCreatePolicy {
  status: ReplicaBranchCreateStatus;
  lagMs: number | null;
}

export function getReplicaBranchCreatePolicy(
  freshness: ReplicaBranchFreshness | null | undefined
): ReplicaBranchCreatePolicy {
  const lagMs = freshness?.lagMs ?? null;
  const byteLag = freshness?.byteLag ?? null;

  if (byteLag === 0) {
    return { status: 'allow', lagMs };
  }

  if (lagMs === null || lagMs < REPLICA_BRANCH_WARN_MS) {
    return { status: 'allow', lagMs };
  }

  if (lagMs <= REPLICA_BRANCH_BLOCK_MS) {
    return { status: 'warn', lagMs };
  }

  return { status: 'block', lagMs };
}
