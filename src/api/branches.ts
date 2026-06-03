import { z } from 'zod';
import { ORPCError, implement } from '@orpc/server';
import { branchesContract } from './branch-contract';
import { publicProcedure, surfaceFullErrorMiddleware } from './context';
import { userFacingError } from './errors';
import { OPEN_API_TAGS } from './openapi-tags';
import { createJob } from '#server/services/job-service';
import { runBranchSql } from '#server/services/sql-editor-service';
import { createBranchApi, deleteBranchApi, getBranchApi, listBranchesApi, resetBranchApi, updateBranchExpiryApi } from '#server/services/branch-api-service';

const restoreBranchInput = z.object({
  targetBranch: z.string().min(1),
  sourceBranch: z.string().min(1),
  restoreTime: z.string().min(1),
  productionRestoreConfirmation: z.string().optional(),
});

const runSqlInput = z.object({
  branchId: z.string().min(1),
  sql: z.string().min(1).max(100_000),
});

const branchContractRouter = implement(branchesContract).use(surfaceFullErrorMiddleware);
const recoveryBranchRoutes = publicProcedure.tag(OPEN_API_TAGS.recovery).router({
  restore: publicProcedure
    .route({
      method: 'POST',
      path: '/branches/{targetBranch}/restore',
      summary: 'Restore branch',
    })
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
});

const dataBranchRoutes = publicProcedure.tag(OPEN_API_TAGS.data).router({
  sql: {
    run: publicProcedure
      .route({
        method: 'POST',
        path: '/branches/{branchId}/sql',
        summary: 'Run branch SQL',
      })
      .input(runSqlInput)
      .handler(async function runSql({ input }) {
        try {
          return await runBranchSql(input);
        } catch (error) {
          throw userFacingError(error, 'SQL failed');
        }
      }),
  },
});

export const branchesRouter = {
  list: branchContractRouter.list.handler(async function listBranches() {
    return listBranchesApi();
  }),
  retrieve: branchContractRouter.retrieve.handler(async function retrieveBranch({ input }) {
    try {
      return await getBranchApi(input.slug);
    } catch (error) {
      throw userFacingError(error, 'Could not load branch');
    }
  }),
  create: branchContractRouter.create.handler(async function createBranch({ input }) {
    try {
      return await createBranchApi(input);
    } catch (error) {
      throw userFacingError(error, 'Could not create branch');
    }
  }),
  delete: branchContractRouter.delete.handler(async function deleteBranchBySlug({ input }) {
    try {
      return await deleteBranchApi(input.slug);
    } catch (error) {
      throw userFacingError(error, 'Could not delete branch');
    }
  }),
  reset: branchContractRouter.reset.handler(async function resetBranch({ input }) {
    try {
      return await resetBranchApi(input.slug);
    } catch (error) {
      throw userFacingError(error, 'Could not reset branch');
    }
  }),
  expiry: {
    update: branchContractRouter.expiry.update.handler(async function updateExpiry({ input }) {
      try {
        return await updateBranchExpiryApi(input);
      } catch (error) {
        throw userFacingError(error, 'Could not update expiry');
      }
    }),
  },
  ...recoveryBranchRoutes,
  ...dataBranchRoutes,
};

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
