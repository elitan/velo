import { describe, expect, test } from 'bun:test';
import { formatPostgresOwner, parsePostgresOwner, resolvePostgresOwner } from './postgres-owner';

describe('parsePostgresOwner', function () {
  test('parses postgres alpine owner', function () {
    expect(parsePostgresOwner('70:70')).toEqual({ uid: '70', gid: '70' });
  });

  test('parses non-alpine postgres owner', function () {
    expect(parsePostgresOwner('999:999')).toEqual({ uid: '999', gid: '999' });
  });

  test('rejects invalid owner output', function () {
    expect(function parseBadOwner() {
      parsePostgresOwner('postgres:postgres');
    }).toThrow('Invalid postgres owner');
  });
});

describe('formatPostgresOwner', function () {
  test('formats chown owner spec', function () {
    expect(formatPostgresOwner({ uid: '999', gid: '999' })).toBe('999:999');
  });
});

describe('resolvePostgresOwner', function () {
  test('resolves default postgres alpine image owner', async function () {
    const owner = await resolvePostgresOwner('postgres:17-alpine', async function runOwnerProbe(image) {
      expect(image).toBe('postgres:17-alpine');
      return {
        exitCode: 0,
        stdout: '70:70',
        stderr: '',
      };
    });

    expect(owner).toEqual({ uid: '70', gid: '70' });
  });

  test('resolves non-70 image owner', async function () {
    const owner = await resolvePostgresOwner('postgres:17', async function runOwnerProbe(image) {
      expect(image).toBe('postgres:17');
      return {
        exitCode: 0,
        stdout: '999:999',
        stderr: '',
      };
    });

    expect(owner).toEqual({ uid: '999', gid: '999' });
  });
});
