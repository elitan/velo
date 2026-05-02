import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { migrateDatabase } from '../../db/migrate';
import { appRouter } from '../../server/root-router';
import { createTrpcContext } from '../../server/trpc';

const serverInput = z.object({
  role: z.enum(['prod', 'dev']),
  host: z.string().min(1),
  sshUser: z.string().min(1),
  sshKeyPath: z.string().min(1),
});

const roleInput = z.object({
  role: z.enum(['prod', 'dev']),
});

const branchInput = z.object({
  name: z.string().min(1),
  parentBranchId: z.number().int().positive().nullable().optional(),
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

const branchIdInput = z.object({
  id: z.number().int().positive(),
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

export const getSetupState = createServerFn({ method: 'GET' }).handler(async function getStateHandler() {
  migrateDatabase();
  const caller = appRouter.createCaller(createTrpcContext());
  return caller.setup.getState();
});

export const saveServerAction = createServerFn({ method: 'POST' })
  .inputValidator(function validateServerInput(data: unknown) {
    return serverInput.parse(data);
  })
  .handler(async function saveServerHandler({ data }) {
    migrateDatabase();
    const caller = appRouter.createCaller(createTrpcContext());
    return caller.setup.saveServer(data);
  });

export const saveBackupSettingsAction = createServerFn({ method: 'POST' })
  .inputValidator(function validateBackupInput(data: unknown) {
    return backupInput.parse(data);
  })
  .handler(async function saveBackupSettingsHandler({ data }) {
    migrateDatabase();
    const caller = appRouter.createCaller(createTrpcContext());
    return caller.setup.saveBackupSettings(data);
  });

export const checkServerAction = createServerFn({ method: 'POST' })
  .inputValidator(function validateRoleInput(data: unknown) {
    return roleInput.parse(data);
  })
  .handler(async function checkServerHandler({ data }) {
    migrateDatabase();
    const caller = appRouter.createCaller(createTrpcContext());
    return caller.setup.checkServer(data);
  });

export const runDevBootstrapAction = createServerFn({ method: 'POST' }).handler(async function runDevBootstrapHandler() {
  migrateDatabase();
  const caller = appRouter.createCaller(createTrpcContext());
  return caller.setup.startDevBootstrap();
});

export const runProdBootstrapAction = createServerFn({ method: 'POST' }).handler(async function runProdBootstrapHandler() {
  migrateDatabase();
  const caller = appRouter.createCaller(createTrpcContext());
  return caller.setup.startProdBootstrap();
});

export const createBranchAction = createServerFn({ method: 'POST' })
  .inputValidator(function validateBranchInput(data: unknown) {
    return branchInput.parse(data);
  })
  .handler(async function createBranchHandler({ data }) {
    migrateDatabase();
    const caller = appRouter.createCaller(createTrpcContext());
    return caller.setup.startCreateBranch(data);
  });

export const deleteBranchAction = createServerFn({ method: 'POST' })
  .inputValidator(function validateBranchIdInput(data: unknown) {
    return branchIdInput.parse(data);
  })
  .handler(async function deleteBranchHandler({ data }) {
    migrateDatabase();
    const caller = appRouter.createCaller(createTrpcContext());
    return caller.setup.startDeleteBranch(data);
  });

export const createPreviewBranchAction = createServerFn({ method: 'POST' })
  .inputValidator(function validatePreviewBranchInput(data: unknown) {
    return previewBranchInput.parse(data);
  })
  .handler(async function createPreviewBranchHandler({ data }) {
    migrateDatabase();
    const caller = appRouter.createCaller(createTrpcContext());
    return caller.setup.createPreviewBranch(data);
  });

export const deletePreviewBranchAction = createServerFn({ method: 'POST' })
  .inputValidator(function validatePreviewBranchIdInput(data: unknown) {
    return branchIdInput.parse(data);
  })
  .handler(async function deletePreviewBranchHandler({ data }) {
    migrateDatabase();
    const caller = appRouter.createCaller(createTrpcContext());
    return caller.setup.deleteBranch(data);
  });

export const restoreBranchAction = createServerFn({ method: 'POST' })
  .inputValidator(function validateRestoreBranchInput(data: unknown) {
    return restoreBranchInput.parse(data);
  })
  .handler(async function restoreBranchHandler({ data }) {
    migrateDatabase();
    const caller = appRouter.createCaller(createTrpcContext());
    return caller.setup.startRestoreBranch(data);
  });

export const resetBranchFromParentAction = createServerFn({ method: 'POST' })
  .inputValidator(function validateResetBranchInput(data: unknown) {
    return branchIdInput.parse(data);
  })
  .handler(async function resetBranchFromParentHandler({ data }) {
    migrateDatabase();
    const caller = appRouter.createCaller(createTrpcContext());
    return caller.setup.startResetBranch(data);
  });

export const createReplicaBaseAction = createServerFn({ method: 'POST' }).handler(async function createReplicaBaseHandler() {
  migrateDatabase();
  const caller = appRouter.createCaller(createTrpcContext());
  return caller.setup.startReplicaBase();
});
