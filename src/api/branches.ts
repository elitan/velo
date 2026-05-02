import { z } from 'zod';
import { getDb } from '#db/client';
import { publicProcedure } from './context';
import { createJob, runJob } from '#server/services/job-service';
import { createBranchFromBase, createPreviewBranch, deleteBranch, normalizeBranchSlug, resetBranchFromParent } from '#server/services/branch-service';
import { restoreDevelopmentBranchFromPgBackRest, restoreProductionFromPgBackRest } from '#server/services/pgbackrest-restore-service';

const branchInput = z.object({
  name: z.string().min(1),
  parentBranchId: z.number().int().positive().nullable().optional(),
});

const branchIdInput = z.object({
  id: z.number().int().positive(),
});

const previewBranchInput = z.object({
  sourceBranch: z.string().min(1),
  restoreTime: z.string().min(1),
});

const restoreBranchInput = z.object({
  targetBranch: z.string().min(1),
  sourceBranch: z.string().min(1),
  restoreTime: z.string().min(1),
});

export const branchesRouter = {
  create: publicProcedure
    .input(branchInput)
    .handler(async function createBranch({ input }) {
      const branchSlug = normalizeBranchSlug(input.name);
      const job = await createJob('create-branch', input);
      runJob(job, async function runCreateBranchJob(context) {
        await context.log(`creating branch ${input.name}`);
        await createBranchFromBase(input);
      });
      return {
        ...job,
        branchSlug,
      };
    }),
  delete: publicProcedure
    .input(branchIdInput)
    .handler(async function deleteBranchById({ input }) {
      const job = await createJob('delete-branch', input);
      runJob(job, async function runDeleteBranchJob(context) {
        await context.log(`deleting branch ${input.id}`);
        const result = await deleteBranch(input);
        await context.log(`deleted branch ${result.displayName}`);
      });
      return job;
    }),
  preview: {
    create: publicProcedure
      .input(previewBranchInput)
      .handler(async function createBranchPreview({ input }) {
        return createPreviewBranch(input);
      }),
    delete: publicProcedure
      .input(branchIdInput)
      .handler(async function deleteBranchPreview({ input }) {
        return deleteBranch(input);
      }),
  },
  restore: publicProcedure
    .input(restoreBranchInput)
    .handler(async function restoreBranch({ input }) {
      const job = await createJob('restore-branch', input);
      runJob(job, async function runRestoreBranchJob(context) {
        await context.log(`restoring ${input.targetBranch} from ${input.sourceBranch}`);

        if (input.targetBranch === 'prod') {
          await restoreProductionFromPgBackRest(input);
          await context.log('production restore completed');
          return;
        }

        const existing = await findBranchBySlug(normalizeBranchLookup(input.targetBranch));

        if (existing) {
          await context.log(`replacing existing branch ${input.targetBranch}`);
          await deleteBranch({ id: existing.id });
        }

        const result = await restoreDevelopmentBranchFromPgBackRest(input);
        await context.log(`branch restored: ${result.displayName}`);
      });
      return job;
    }),
  reset: publicProcedure
    .input(branchIdInput)
    .handler(async function resetBranch({ input }) {
      const job = await createJob('reset-branch', input);
      runJob(job, async function runResetBranchJob(context) {
        await context.log(`resetting branch ${input.id} from parent`);
        const result = await resetBranchFromParent(input);
        await context.log(`reset branch ${result.displayName}`);
      });
      return job;
    }),
};

async function findBranchBySlug(slug: string): Promise<{ id: number } | undefined> {
  return getDb()
    .selectFrom('branches')
    .select(['id'])
    .where('slug', '=', slug)
    .executeTakeFirst();
}

function normalizeBranchLookup(name: string): string {
  return name.trim().toLowerCase();
}
