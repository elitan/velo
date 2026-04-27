import { describe, expect, test } from 'bun:test';
import {
  buildSnapshotScheduleCronBlock,
  getSnapshotScheduleRunnerInfo,
  installSnapshotScheduleCron,
  removeSnapshotScheduleCron,
} from './snapshot-runner-service';

describe('snapshot schedule runner', function () {
  test('builds cron block', function () {
    expect(buildSnapshotScheduleCronBlock('/usr/local/bin/velo snapshot schedule run', 5)).toBe([
      '# velo snapshot schedule start',
      '*/5 * * * * /usr/local/bin/velo snapshot schedule run',
      '# velo snapshot schedule end',
    ].join('\n'));
  });

  test('installs cron block without touching other entries', function () {
    const current = '0 0 * * * backup\n';
    const result = installSnapshotScheduleCron(current, 'velo snapshot schedule run', 15);

    expect(result).toBe([
      '0 0 * * * backup',
      '',
      '# velo snapshot schedule start',
      '*/15 * * * * velo snapshot schedule run',
      '# velo snapshot schedule end',
      '',
    ].join('\n'));
  });

  test('replaces existing cron block', function () {
    const current = installSnapshotScheduleCron('', 'velo snapshot schedule run', 15);
    const result = installSnapshotScheduleCron(current, 'velo snapshot schedule run --dry-run', 30);

    expect(result).toBe([
      '# velo snapshot schedule start',
      '*/30 * * * * velo snapshot schedule run --dry-run',
      '# velo snapshot schedule end',
      '',
    ].join('\n'));
  });

  test('removes only velo cron block', function () {
    const current = installSnapshotScheduleCron('0 0 * * * backup\n', 'velo snapshot schedule run', 5);

    expect(removeSnapshotScheduleCron(current)).toBe('0 0 * * * backup');
  });

  test('reads installed cron info', function () {
    const current = installSnapshotScheduleCron('', 'velo snapshot schedule run', 10);

    expect(getSnapshotScheduleRunnerInfo(current)).toEqual({
      installed: true,
      everyMinutes: 10,
      command: 'velo snapshot schedule run',
    });
  });

  test('reports missing cron block', function () {
    expect(getSnapshotScheduleRunnerInfo('0 0 * * * backup')).toEqual({
      installed: false,
    });
  });
});
