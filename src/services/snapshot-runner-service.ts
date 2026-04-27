export const SNAPSHOT_SCHEDULE_CRON_START = '# velo snapshot schedule start';
export const SNAPSHOT_SCHEDULE_CRON_END = '# velo snapshot schedule end';

export interface SnapshotScheduleRunnerInfo {
  installed: boolean;
  everyMinutes?: number;
  command?: string;
}

export function buildSnapshotScheduleCronBlock(command: string, everyMinutes: number): string {
  return [
    SNAPSHOT_SCHEDULE_CRON_START,
    `${getMinuteField(everyMinutes)} * * * * ${command}`,
    SNAPSHOT_SCHEDULE_CRON_END,
  ].join('\n');
}

export function installSnapshotScheduleCron(current: string, command: string, everyMinutes: number): string {
  const withoutExisting = removeSnapshotScheduleCron(current).trim();
  const block = buildSnapshotScheduleCronBlock(command, everyMinutes);

  if (withoutExisting.length === 0) {
    return `${block}\n`;
  }

  return `${withoutExisting}\n\n${block}\n`;
}

export function removeSnapshotScheduleCron(current: string): string {
  const pattern = new RegExp(
    `${escapeRegExp(SNAPSHOT_SCHEDULE_CRON_START)}[\\s\\S]*?${escapeRegExp(SNAPSHOT_SCHEDULE_CRON_END)}\\n?`,
    'g'
  );

  return current.replace(pattern, '').trimEnd();
}

export function getSnapshotScheduleRunnerInfo(current: string): SnapshotScheduleRunnerInfo {
  const pattern = new RegExp(
    `${escapeRegExp(SNAPSHOT_SCHEDULE_CRON_START)}\\n([\\s\\S]*?)\\n${escapeRegExp(SNAPSHOT_SCHEDULE_CRON_END)}`
  );
  const match = current.match(pattern);

  if (!match || !match[1]) {
    return { installed: false };
  }

  const line = match[1].split('\n').find(function (item) {
    return item.trim().length > 0;
  });

  if (!line) {
    return { installed: true };
  }

  const cronMatch = line.match(/^(\*|\*\/(\d+)) \* \* \* \* (.+)$/);
  if (!cronMatch) {
    return { installed: true, command: line };
  }

  return {
    installed: true,
    everyMinutes: cronMatch[2] ? Number.parseInt(cronMatch[2], 10) : 1,
    command: cronMatch[3],
  };
}

function getMinuteField(everyMinutes: number): string {
  if (everyMinutes === 1) {
    return '*';
  }

  return `*/${everyMinutes}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
