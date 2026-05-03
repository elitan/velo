import { z } from 'zod';
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
});

const runSqlInput = z.object({
  branchId: z.string().min(1),
  sql: z.string().min(1).max(100_000),
});

export const branchesRouter = {
  create: publicProcedure
    .input(branchInput)
    .handler(async function createBranch({ input }) {
      const branchSlug = normalizeBranchSlug(input.name);
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
      const job = await createJob('restore-branch', input);
      return job;
    }),
  reset: publicProcedure
    .input(branchIdInput)
    .handler(async function resetBranch({ input }) {
      const job = await createJob('reset-branch', input);
      return job;
    }),
};
