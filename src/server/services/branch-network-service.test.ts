import { describe, expect, test } from 'bun:test';
import { getBranchConnectionHost, shouldExposeBranchPostgres } from './branch-network-service';

describe('branch network access', function () {
  test('keeps branch PostgreSQL private by default', function () {
    expect(shouldExposeBranchPostgres()).toBe(false);
    expect(shouldExposeBranchPostgres(false)).toBe(false);
    expect(getBranchConnectionHost('203.0.113.10')).toBe('localhost');
  });

  test('uses the dev host only when public access is explicit', function () {
    expect(shouldExposeBranchPostgres(true)).toBe(true);
    expect(getBranchConnectionHost('203.0.113.10', true)).toBe('203.0.113.10');
  });
});
