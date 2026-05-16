import { z } from 'zod';
import { ORPCError } from '@orpc/server';
import { getDb } from '#db/client';
import { publicProcedure } from './context';
import { userFacingError } from './errors';
import { createJob } from '#server/services/job-service';
import { createPreviewBranch, normalizeBranchSlug, updateBranchExpiry } from '#server/services/branch-service';
import { runBranchSql } from '#server/services/sql-editor-service';

const branchInput = z.object({
  name: z.string().min(1),
  parentBranchId: z.number().int().positive().nullable().optional(),
  ttlHours: z.number().positive().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
});

const branchIdInput = z.object({
  id: z.number().int().positive(),
});

const branchExpiryInput = z.object({
  id: z.number().int().positive(),
  expiresAt: z.string().nullable(),
});

const previewBranchInput = z.object({
  sourceBranch: z.string().min(1),
  restoreTime: z.string().min(1),
});

const restoreBranchInput = z.object({
  targetBranch: z.string().min(1),
  sourceBranch: z.string().min(1),
  restoreTime: z.string().min(1),
  productionRestoreConfirmation: z.string().optional(),
});

const runSqlInput = z.object({
  branchId: z.string().min(1),
  sql: z.string().min(1).max(100_000),
  productionWriteConfirmation: z.string().optional(),
});

export const branchesRouter = {
  create: publicProcedure
    .input(branchInput)
    .handler(async function createBranch({ input }) {
      const branchSlug = normalizeBranchSlug(input.name);
      await assertBranchSlugAvailable(branchSlug);
      const job = await createJob('create-branch', input);
      return {
        ...job,
        branchSlug,
      };
    }),
  delete: publicProcedure
    .input(branchIdInput)
    .handler(async function deleteBranchById({ input }) {
      const job = await createJob('delete-branch', input);
      return job;
    }),
  expiry: {
    update: publicProcedure
      .input(branchExpiryInput)
      .handler(async function updateExpiry({ input }) {
        return updateBranchExpiry(input);
      }),
  },
  preview: {
    create: publicProcedure
      .input(previewBranchInput)
      .handler(async function createBranchPreview({ input }) {
        return createPreviewBranch(input);
      }),
    delete: publicProcedure
      .input(branchIdInput)
      .handler(async function deleteBranchPreview({ input }) {
        return createJob('delete-branch', input);
      }),
  },
  sql: {
    run: publicProcedure
      .input(runSqlInput)
      .handler(async function runSql({ input }) {
        try {
          return await runBranchSql(input);
        } catch (error) {
          throw userFacingError(error, 'SQL failed');
        }
      }),
  },
  restore: publicProcedure
    .input(restoreBranchInput)
    .handler(async function restoreBranch({ input }) {
      assertProductionRestoreConfirmed(input.targetBranch, input.productionRestoreConfirmation);
      const job = await createJob('restore-branch', {
        targetBranch: input.targetBranch,
        sourceBranch: input.sourceBranch,
        restoreTime: input.restoreTime,
      });
      return job;
    }),
  reset: publicProcedure
    .input(branchIdInput)
    .handler(async function resetBranch({ input }) {
      const job = await createJob('reset-branch', input);
      return job;
    }),
};

async function assertBranchSlugAvailable(branchSlug: string): Promise<void> {
  const db = getDb();
  const existingBranch = await db
    .selectFrom('branches')
    .select('id')
    .where('slug', '=', branchSlug)
    .executeTakeFirst();

  if (existingBranch) {
    throwDuplicateBranch(branchSlug);
  }

  const activeCreateJobs = await db
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

function assertProductionRestoreConfirmed(targetBranch: string, confirmation: string | undefined): void {
  if (!isProductionRestoreTarget(targetBranch)) {
    return;
  }

  if (confirmation === 'restore production') {
    return;
  }

  throw new ORPCError('BAD_REQUEST', {
    message: 'Type restore production to restore production',
  });
}

function isProductionRestoreTarget(targetBranch: string): boolean {
  const normalized = targetBranch.trim().toLowerCase();
  return normalized === 'production' || normalized === 'prod';
}

function throwDuplicateBranch(branchSlug: string): never {
  throw new ORPCError('BAD_REQUEST', {
    message: `Branch already exists: ${branchSlug}`,
  });
}
