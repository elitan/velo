import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPostgresArchiveCommand, getPostgresHostIp } from './docker';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'velo-wal-'));
  tempDirs.push(dir);
  return dir;
}

function commandFor(command: string, sourcePath: string, fileName: string): string {
  return command.replaceAll('%p', sourcePath).replaceAll('%f', fileName);
}

async function runArchiveCommand(command: string): Promise<number> {
  const proc = Bun.spawn(['sh', '-c', command], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  await proc.exited;
  return proc.exitCode ?? 1;
}

afterEach(async function cleanup() {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('DockerManager PostgreSQL host binding', function () {
  test('binds PostgreSQL to localhost by default', function () {
    expect(getPostgresHostIp({})).toBe('127.0.0.1');
  });

  test('binds PostgreSQL to all interfaces when public access is explicit', function () {
    expect(getPostgresHostIp({ publicAccess: true })).toBe('0.0.0.0');
  });
});

describe('buildPostgresArchiveCommand', function () {
  test('archives a WAL file the first time', async function () {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'pg-wal');
    const archiveDir = join(dir, 'archive');
    const fileName = '000000010000000000000001';
    await writeFile(sourcePath, 'wal-data');
    await Bun.$`mkdir ${archiveDir}`.quiet();

    const command = commandFor(
      buildPostgresArchiveCommand(archiveDir),
      sourcePath,
      fileName
    );

    expect(await runArchiveCommand(command)).toBe(0);
    expect(await Bun.file(join(archiveDir, fileName)).text()).toBe('wal-data');
  });

  test('treats duplicate identical WAL files as success', async function () {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'pg-wal');
    const archiveDir = join(dir, 'archive');
    const fileName = '000000010000000000000001';
    await Bun.$`mkdir ${archiveDir}`.quiet();
    await writeFile(sourcePath, 'wal-data');
    await writeFile(join(archiveDir, fileName), 'wal-data');

    const command = commandFor(
      buildPostgresArchiveCommand(archiveDir),
      sourcePath,
      fileName
    );

    expect(await runArchiveCommand(command)).toBe(0);
  });

  test('fails when the WAL file cannot be copied', async function () {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'pg-wal');
    const archivePath = join(dir, 'archive-file');
    const fileName = '000000010000000000000001';
    await writeFile(sourcePath, 'wal-data');
    await writeFile(archivePath, 'not-a-directory');

    const command = commandFor(
      buildPostgresArchiveCommand(archivePath),
      sourcePath,
      fileName
    );

    expect(await runArchiveCommand(command)).not.toBe(0);
  });
});
