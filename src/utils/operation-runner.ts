import { withProgress } from './progress';

export type OperationRollback = () => Promise<void>;
export type OperationStep<T> = () => Promise<T>;
export type OperationStepRollback<T> = (result: T) => Promise<void>;

export interface OperationRunnerOptions {
  failureMessage?: string;
  runStep?: <T>(label: string, operation: OperationStep<T>) => Promise<T>;
  writeMessage?: (message: string) => void;
  writeRollbackError?: (message: string) => void;
  writeRollbackSummary?: (message: string) => void;
}

export class OperationRunner {
  private rollbacks: OperationRollback[] = [];

  constructor(private options: OperationRunnerOptions = {}) {}

  async run<T>(operation: (runner: OperationRunner) => Promise<T>): Promise<T> {
    try {
      const result = await operation(this);
      this.clear();
      return result;
    } catch (error) {
      this.writeFailureMessage();
      await this.rollback();
      throw error;
    }
  }

  async step<T>(
    label: string,
    operation: OperationStep<T>,
    rollback?: OperationStepRollback<T>
  ): Promise<T> {
    const runStep = this.options.runStep || withProgress;
    const result = await runStep(label, operation);

    if (rollback) {
      this.addRollback(async function rollbackStep() {
        await rollback(result);
      });
    }

    return result;
  }

  addRollback(rollback: OperationRollback): void {
    this.rollbacks.push(rollback);
  }

  clear(): void {
    this.rollbacks = [];
  }

  async rollback(): Promise<void> {
    const errors: Error[] = [];

    for (const rollback of [...this.rollbacks].reverse()) {
      try {
        await rollback();
      } catch (error: any) {
        errors.push(error);
        this.writeRollbackError(`Rollback step failed: ${error.message}`);
      }
    }

    if (errors.length > 0) {
      this.writeRollbackSummary(`Rollback completed with ${errors.length} error(s)`);
    }
  }

  get length(): number {
    return this.rollbacks.length;
  }

  private writeFailureMessage(): void {
    const message = this.options.failureMessage || 'Operation failed, cleaning up...';
    const writeMessage = this.options.writeMessage || console.log;

    writeMessage('');
    writeMessage(message);
  }

  private writeRollbackError(message: string): void {
    const writeRollbackError = this.options.writeRollbackError || console.error;
    writeRollbackError(message);
  }

  private writeRollbackSummary(message: string): void {
    const writeRollbackSummary = this.options.writeRollbackSummary || console.warn;
    writeRollbackSummary(message);
  }
}
