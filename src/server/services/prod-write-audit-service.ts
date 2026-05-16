import { createAuditJob } from './job-service';

export interface ProdWriteAuditInput {
  area: 'sql' | 'tables';
  action: string;
  branchId: string;
  allowed: boolean;
  target: string;
}

export async function auditProdWriteAttempt(input: ProdWriteAuditInput): Promise<void> {
  const status = input.allowed ? 'allowed' : 'blocked';
  await createAuditJob('prod-write-attempt', {
    area: input.area,
    action: input.action,
    branchId: input.branchId,
    allowed: input.allowed,
    target: input.target,
  }, `${status} production ${input.area} write: ${input.action} ${input.target}`);
}
