import { z } from 'zod';
import { getDb } from '#db/client';
import { createBranchFromBase, deleteBranch, normalizeBranchSlug, resetBranchFromParent } from '#server/services/branch-service';
import { restoreDevelopmentBranchFromPgBackRest, restoreProductionFromPgBackRest } from '#server/services/pgbackrest-restore-service';
import { runDevBootstrap, runProdBootstrap, type BootstrapResult } from '#server/services/bootstrap-service';
import { createReplicaBase, type ReplicaResult } from '#server/services/replica-service';
import { checkServer } from '#server/services/setup-state-service';
import type { JobContext, JobHandlers } from './job-service';

const branchInput = z.object({
  name: z.string().min(1),
  parentBranchId: z.number().int().positive().nullable().optional(),
});

const branchIdInput = z.object({
  id: z.number().int().positive(),
});

const restoreBranchInput = z.object({
  targetBranch: z.string().min(1),
  sourceBranch: z.string().min(1),
  restoreTime: z.string().min(1),
});

export const jobHandlers: JobHandlers = {
  'create-branch': async function createBranchJob(input, context) {
    const parsed = branchInput.parse(input);
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
  'restore-branch': async function restoreBranchJob(input, context) {
    const parsed = restoreBranchInput.parse(input);
    await context.log(`restoring ${parsed.targetBranch} from ${parsed.sourceBranch}`);

    if (parsed.targetBranch.trim().toLowerCase() === 'prod') {
      context.disableRetry();
      await restoreProductionFromPgBackRest(parsed);
      await context.log('production restore completed');
      return;
    }

    const existing = await findBranchBySlug(normalizeBranchLookup(parsed.targetBranch));

    if (existing) {
      await context.log(`replacing existing branch ${parsed.targetBranch}`);
      await deleteBranch({ id: existing.id });
    }

    const result = await restoreDevelopmentBranchFromPgBackRest(parsed);
    await context.log(`branch restored: ${result.displayName}`);
  },
  'reset-branch': async function resetBranchJob(input, context) {
    const parsed = branchIdInput.parse(input);
    await context.log(`resetting branch ${parsed.id} from parent`);
    const result = await resetBranchFromParent(parsed);
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
  setup: async function setupJob(_input, context) {
    await runSetupJob(context);
  },
  'replica-base': async function replicaBaseJob(_input, context) {
    await context.log('creating dev replica base');
    assertOk(await createReplicaBase());
  },
};

async function runSetupJob(context: JobContext): Promise<void> {
  if (!(await isStepDone('dev-check'))) {
    await context.log('setting up dev server');
    assertOk(await runDevBootstrap());
  }

  if (!(await isStepDone('prod-check'))) {
    await context.log('checking prod server');
    await checkServer('prod');
  }

  if (!(await isStepDone('prod-setup')) || !(await isStepDone('backups'))) {
    await context.log('setting up prod Postgres and backups');
    assertOk(await runProdBootstrap());
  }

  if (!(await isStepDone('replica'))) {
    await context.log('creating dev replica base');
    assertOk(await createReplicaBase());
  }

  if (!(await isStepDone('first-branch'))) {
    await context.log('creating first dev branch');
    await createBranchFromBase({ name: 'dev' });
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

async function findBranchBySlug(slug: string): Promise<{ id: number } | undefined> {
  return getDb()
    .selectFrom('branches')
    .select(['id'])
    .where('slug', '=', slug)
    .executeTakeFirst();
}

function normalizeBranchLookup(name: string): string {
  return normalizeBranchSlug(name.trim().toLowerCase());
}

function assertOk(result: BootstrapResult | ReplicaResult): void {
  if (!result.ok) {
    throw new Error(result.message);
  }
}
