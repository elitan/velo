import { describe, expect, test } from 'bun:test';
import { OperationRunner } from './operation-runner';

function createRunner(events: string[]): OperationRunner {
  return new OperationRunner({
    runStep: async function runStep<T>(label: string, operation: () => Promise<T>): Promise<T> {
      events.push(`step:${label}`);
      return await operation();
    },
    writeMessage: function writeMessage(message: string) {
      events.push(`message:${message}`);
    },
    writeRollbackError: function writeRollbackError(message: string) {
      events.push(`rollback-error:${message}`);
    },
    writeRollbackSummary: function writeRollbackSummary(message: string) {
      events.push(`rollback-summary:${message}`);
    },
  });
}

describe('OperationRunner', function () {
  test('clears rollback steps after success', async function () {
    const events: string[] = [];
    const runner = createRunner(events);

    const result = await runner.run(async function runOperation(operation) {
      operation.addRollback(async function rollbackStep() {
        events.push('rollback');
      });

      return 'ok';
    });

    expect(result).toBe('ok');
    expect(runner.length).toBe(0);
    expect(events).toEqual([]);
  });

  test('runs rollback steps in reverse order after failure', async function () {
    const events: string[] = [];
    const runner = createRunner(events);
    const error = new Error('failed');

    await expect(runner.run(async function runOperation(operation) {
      operation.addRollback(async function firstRollback() {
        events.push('first');
      });
      operation.addRollback(async function secondRollback() {
        events.push('second');
      });

      throw error;
    })).rejects.toThrow(error);

    expect(events).toEqual([
      'message:',
      'message:Operation failed, cleaning up...',
      'second',
      'first',
    ]);
  });

  test('adds step rollback only after the step succeeds', async function () {
    const events: string[] = [];
    const runner = createRunner(events);

    await expect(runner.run(async function runOperation(operation) {
      await operation.step(
        'Failing step',
        async function failingStep() {
          throw new Error('step failed');
        },
        async function rollbackStep() {
          events.push('rollback');
        }
      );
    })).rejects.toThrow('step failed');

    expect(events).toEqual([
      'step:Failing step',
      'message:',
      'message:Operation failed, cleaning up...',
    ]);
  });

  test('passes step result to rollback', async function () {
    const events: string[] = [];
    const runner = createRunner(events);

    await expect(runner.run(async function runOperation(operation) {
      await operation.step(
        'Create item',
        async function createItem() {
          return 'item-id';
        },
        async function rollbackStep(result) {
          events.push(`rollback:${result}`);
        }
      );

      throw new Error('later failure');
    })).rejects.toThrow('later failure');

    expect(events).toEqual([
      'step:Create item',
      'message:',
      'message:Operation failed, cleaning up...',
      'rollback:item-id',
    ]);
  });

  test('continues rollback after rollback errors', async function () {
    const events: string[] = [];
    const runner = createRunner(events);

    await expect(runner.run(async function runOperation(operation) {
      operation.addRollback(async function firstRollback() {
        events.push('first');
      });
      operation.addRollback(async function brokenRollback() {
        throw new Error('broken');
      });

      throw new Error('failed');
    })).rejects.toThrow('failed');

    expect(events).toEqual([
      'message:',
      'message:Operation failed, cleaning up...',
      'rollback-error:Rollback step failed: broken',
      'first',
      'rollback-summary:Rollback completed with 1 error(s)',
    ]);
  });
});
