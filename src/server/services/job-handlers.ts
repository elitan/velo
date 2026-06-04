import { z } from 'zod';
import { getDb } from '#db/client';
import { createBranchFromBase, deleteBranch, normalizeBranchSlug, replaceBranchWithReadyBranch, resetBranchFromParent } from '#server/services/branch-service';
import { restoreDevelopmentBranchFromPgBackRest, restoreProductionFromPgBackRest } from '#server/services/pgbackrest-restore-service';
import { reconfigureProdBackups, runDevBootstrap, runProdBootstrap, type BootstrapResult } from '#server/services/bootstrap-service';
import { createReplicaBase, type ReplicaResult } from '#server/services/replica-service';
import { checkServer } from '#server/services/setup-state-service';
import type { JobContext, JobHandlers } from './job-service';

const branchInput = z.object({
  name: z.string().min(1),
  parentBranchId: z.number().int().positive().nullable().optional(),
  ttlHours: z.number().positive().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  forceReplicaStale: z.boolean().optional(),
});

const branchIdInput = z.object({
  id: z.number().int().positive(),
});

const branchCleanupInput = z.object({
  branchId: z.number().int().positive(),
  branchSlug: z.string().min(1),
  expiresAt: z.string().nullable(),
});

const restoreBranchInput = z.object({
  targetBranch: z.string().min(1),
  sourceBranch: z.string().min(1),
  restoreTime: z.string().min(1),
});

export const jobHandlers: JobHandlers = {
  'create-branch': async function createBranchJob(input, context) {
    const parsed = parseCreateBranchJobInput(input);
    await context.log(`creating branch ${parsed.name}`);
    await createBranchFromBase(parsed);
  },
  'delete-branch': async function deleteBranchJob(input, context) {
    const parsed = branchIdInput.parse(input);
    await context.log(`deleting branch ${parsed.id}`);

    if (!(await branchExists(parsed.id))) {
      await context.log(`branch ${parsed.id} already deleted`);
      return;
    }

    const result = await deleteBranch(parsed);
    await context.log(`deleted branch ${result.displayName}`);
  },
  'branch-cleanup': async function branchCleanupJob(input, context) {
    const parsed = branchCleanupInput.parse(input);
    await context.log(`deleting expired branch ${parsed.branchSlug}`);

    if (!(await branchExists(parsed.branchId))) {
      await context.log(`branch ${parsed.branchSlug} already deleted`);
      return;
    }

    const result = await deleteBranch({ id: parsed.branchId });
    await context.log(`deleted expired branch ${result.displayName}`);
  },
  'restore-branch': async function restoreBranchJob(input, context) {
    const parsed = restoreBranchInput.parse(input);
    await context.log(`restoring ${parsed.targetBranch} from ${parsed.sourceBranch}`);

    if (isProductionBranch(parsed.targetBranch)) {
      context.disableRetry();
      await restoreProductionFromPgBackRest(parsed);
      await context.log('production restore completed');
      return;
    }

    const existing = await findBranchBySlug(normalizeBranchLookup(parsed.targetBranch));
    const branchPassword = getPasswordFromConnectionUrl(existing?.connectionUrl || null);

    if (existing) {
      await context.log(`replacing existing branch ${parsed.targetBranch}`);
      let result: Awaited<ReturnType<typeof replaceBranchWithReadyBranch>>;

      try {
        const replacement = await restoreDevelopmentBranchFromPgBackRest({
          ...parsed,
          targetBranch: buildReplacementBranchSlug(parsed.targetBranch),
          branchPassword,
        });
        result = await replaceBranchWithReadyBranch({
          targetBranchId: existing.id,
          replacementBranchId: replacement.id,
        });
      } catch (error) {
        await context.log(`restore failed; kept existing branch ${parsed.targetBranch}`);
        throw error;
      }

      for (const message of result.cleanupLogs) {
        await context.log(message);
      }

      await context.log(`branch restored: ${result.displayName}`);
      return;
    }

    const result = await restoreDevelopmentBranchFromPgBackRest({
      ...parsed,
      branchPassword,
    });
    await context.log(`branch restored: ${result.displayName}`);
  },
  'reset-branch': async function resetBranchJob(input, context) {
    const parsed = branchIdInput.parse(input);
    await context.log(`resetting branch ${parsed.id} from parent`);
    let result: Awaited<ReturnType<typeof resetBranchFromParent>>;

    try {
      result = await resetBranchFromParent(parsed);
    } catch (error) {
      await context.log(`reset failed; kept existing branch ${parsed.id}`);
      throw error;
    }

    for (const message of result.cleanupLogs) {
      await context.log(message);
    }
    await context.log(`reset branch ${result.displayName}`);
  },
  'dev-bootstrap': async function devBootstrapJob(_input, context) {
    await context.log('installing dev prerequisites');
    assertOk(await runDevBootstrap());
  },
  'prod-bootstrap': async function prodBootstrapJob(_input, context) {
    await context.log('installing prod Postgres and backups');
    assertOk(await runProdBootstrap());
  },
  'backup-reconfigure': async function backupReconfigureJob(_input, context) {
    await context.log('applying backup settings to prod');
    assertOk(await reconfigureProdBackups());
  },
  setup: async function setupJob(_input, context) {
    await runSetupJob(context);
  },
  'replica-base': async function replicaBaseJob(_input, context) {
    await context.log('creating dev replica base');
    assertOk(await createReplicaBase());
  },
};

export function parseCreateBranchJobInput(input: unknown) {
  return branchInput.parse(input);
}

function isProductionBranch(branch: string): boolean {
  const normalized = branch.trim().toLowerCase();
  return normalized === 'production' || normalized === 'prod';
}

async function runSetupJob(context: JobContext): Promise<void> {
  if (!(await isStepDone('dev-check'))) {
    await context.log('setting up dev server');
    assertOk(await runDevBootstrap());
  }

  if (!(await isStepDone('prod-check'))) {
    await context.log('checking prod server');
    const server = await checkServer('prod');

    if (server.status !== 'ok') {
      throw new Error(server.statusMessage || 'prod server check failed');
    }
  }

  if (!(await isStepDone('prod-setup')) || !(await isStepDone('backups'))) {
    await context.log('setting up prod Postgres and backups');
    assertOk(await runProdBootstrap());
  }

  if (!(await isStepDone('replica'))) {
    await context.log('creating dev replica base');
    assertOk(await createReplicaBase());
  }
}

async function isStepDone(key: string): Promise<boolean> {
  const step = await getDb()
    .selectFrom('setupSteps')
    .select(['status'])
    .where('key', '=', key)
    .executeTakeFirst();

  return step?.status === 'done';
}

async function branchExists(id: number): Promise<boolean> {
  const branch = await getDb()
    .selectFrom('branches')
    .select(['id'])
    .where('id', '=', id)
    .executeTakeFirst();

  return Boolean(branch);
}

async function findBranchBySlug(slug: string): Promise<{
  id: number;
  connectionUrl: string | null;
} | undefined> {
  return getDb()
    .selectFrom('branches')
    .select(['id', 'connectionUrl'])
    .where('slug', '=', slug)
    .executeTakeFirst();
}

function normalizeBranchLookup(name: string): string {
  return normalizeBranchSlug(name.trim().toLowerCase());
}

function buildReplacementBranchSlug(slug: string): string {
  const normalized = normalizeBranchLookup(slug);
  const suffix = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23).toLowerCase();
  const prefix = normalized.slice(0, Math.max(1, 63 - suffix.length - 5));
  return normalizeBranchSlug(`${prefix}-tmp-${suffix}`);
}

function assertOk(result: BootstrapResult | ReplicaResult): void {
  if (!result.ok) {
    throw new Error(result.message);
  }
}

function getPasswordFromConnectionUrl(connectionUrl: string | null): string | null {
  if (!connectionUrl) {
    return null;
  }

  try {
    return decodeURIComponent(new URL(connectionUrl).password);
  } catch {
    return null;
  }
}
