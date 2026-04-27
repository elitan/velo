import { describe, expect, test } from 'bun:test';
import { getPostgresHostIp } from './docker';

describe('DockerManager PostgreSQL host binding', function () {
  test('binds PostgreSQL to localhost by default', function () {
    expect(getPostgresHostIp({})).toBe('127.0.0.1');
  });

  test('binds PostgreSQL to all interfaces when public access is explicit', function () {
    expect(getPostgresHostIp({ publicAccess: true })).toBe('0.0.0.0');
  });
});
