import { z } from 'zod';
import { publicProcedure, router } from '../trpc';
import { checkServer, getDashboardState, saveServer } from '../services/setup-state-service';
import { runDevBootstrap, runProdBootstrap } from '../services/bootstrap-service';
import { createBranchFromBase, createPreviewBranch, deleteBranch } from '../services/branch-service';
import { createReplicaBase } from '../services/replica-service';
import { createJob, getActiveJob, getJob, listJobs, runJob } from '../services/job-service';
import { saveBackupSettings } from '../services/settings-service';
import {
  restoreDevelopmentBranchFromPgBackRest,
  restoreProductionFromPgBackRest,
} from '../services/pgbackrest-restore-service';

const serverInput = z.object({
  role: z.enum(['prod', 'dev']),
  host: z.string().min(1),
  sshUser: z.string().min(1),
  sshKeyPath: z.string().min(1),
});

const backupInput = z.object({
  enabled: z.boolean(),
  endpoint: z.string(),
  bucket: z.string(),
  region: z.string(),
  accessKeyId: z.string(),
  secretAccessKey: z.string().optional(),
  path: z.string(),
  pitrDays: z.number().int().positive().optional(),
  fullBackupRetentionDays: z.number().int().positive().optional(),
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

export const setupRouter = router({
  getState: publicProcedure.query(async function getState() {
    return getDashboardState();
  }),
  listJobs: publicProcedure.query(async function listJobsQuery() {
    return listJobs();
  }),
  getJob: publicProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async function getJobQuery({ input }) {
      return getJob(input.id);
    }),
  saveServer: publicProcedure.input(serverInput).mutation(async function saveServerMutation({ input }) {
    return saveServer(input);
  }),
  saveBackupSettings: publicProcedure.input(backupInput).mutation(async function saveBackupSettingsMutation({ input }) {
    return saveBackupSettings(input);
  }),
  checkServer: publicProcedure
    .input(z.object({ role: z.enum(['prod', 'dev']) }))
    .mutation(async function checkServerMutation({ input }) {
      return checkServer(input.role);
    }),
  runDevBootstrap: publicProcedure.mutation(async function runDevBootstrapMutation() {
    return runDevBootstrap();
  }),
  runProdBootstrap: publicProcedure.mutation(async function runProdBootstrapMutation() {
    return runProdBootstrap();
  }),
  createBranch: publicProcedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async function createBranchMutation({ input }) {
      return createBranchFromBase(input);
    }),
  deleteBranch: publicProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async function deleteBranchMutation({ input }) {
      return deleteBranch(input);
    }),
  createPreviewBranch: publicProcedure
    .input(previewBranchInput)
    .mutation(async function createPreviewBranchMutation({ input }) {
      return createPreviewBranch(input);
    }),
  startRestoreBranch: publicProcedure
    .input(restoreBranchInput)
    .mutation(async function startRestoreBranchMutation({ input }) {
      const job = await createJob('restore-branch', input);
      runJob(job, async function runRestoreBranchJob(context) {
        await context.log(`restoring ${input.targetBranch} from ${input.sourceBranch}`);

        if (input.targetBranch === 'prod') {
          await restoreProductionFromPgBackRest(input);
          await context.log('production restore completed');
          return;
        }

        const result = await restoreDevelopmentBranchFromPgBackRest(input);
        await context.log(`branch restored: ${result.name}`);
      });
      return job;
    }),
  createReplicaBase: publicProcedure.mutation(async function createReplicaBaseMutation() {
    return createReplicaBase();
  }),
  startDevBootstrap: publicProcedure.mutation(async function startDevBootstrapMutation() {
    const active = await getActiveJob('dev-bootstrap');
    if (active) {
      return active;
    }
    const job = await createJob('dev-bootstrap');
    runJob(job, async function runDevBootstrapJob(context) {
      await context.log('installing dev prerequisites');
      assertOk(await runDevBootstrap());
    });
    return job;
  }),
  startProdBootstrap: publicProcedure.mutation(async function startProdBootstrapMutation() {
    const active = await getActiveJob('prod-bootstrap');
    if (active) {
      return active;
    }
    const job = await createJob('prod-bootstrap');
    runJob(job, async function runProdBootstrapJob(context) {
      await context.log('installing prod Postgres and backups');
      assertOk(await runProdBootstrap());
    });
    return job;
  }),
  startReplicaBase: publicProcedure.mutation(async function startReplicaBaseMutation() {
    const active = await getActiveJob('replica-base');
    if (active) {
      return active;
    }
    const job = await createJob('replica-base');
    runJob(job, async function runReplicaBaseJob(context) {
      await context.log('creating dev replica base');
      assertOk(await createReplicaBase());
    });
    return job;
  }),
  startCreateBranch: publicProcedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async function startCreateBranchMutation({ input }) {
      const job = await createJob('create-branch', input);
      runJob(job, async function runCreateBranchJob(context) {
        await context.log(`creating branch ${input.name}`);
        await createBranchFromBase(input);
      });
      return job;
    }),
  startDeleteBranch: publicProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async function startDeleteBranchMutation({ input }) {
      const job = await createJob('delete-branch', input);
      runJob(job, async function runDeleteBranchJob(context) {
        await context.log(`deleting branch ${input.id}`);
        const result = await deleteBranch(input);
        await context.log(`deleted branch ${result.name}`);
      });
      return job;
    }),
});

function assertOk(result: { ok: boolean; message: string }): void {
  if (!result.ok) {
    throw new Error(result.message);
  }
}
