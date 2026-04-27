import { describe, expect, test } from 'bun:test';
import { formatConnectionString } from './network';

describe('connection string formatting', function () {
  test('does not show a remote URL without public IP', function () {
    const output = formatConnectionString('postgres', 'secret', 5432, 'postgres', null);

    expect(output).toContain('localhost');
    expect(output).not.toContain('Remote:');
  });

  test('shows a remote URL when public IP is provided', function () {
    const output = formatConnectionString('postgres', 'secret', 5432, 'postgres', '203.0.113.10');

    expect(output).toContain('Local:');
    expect(output).toContain('Remote:');
    expect(output).toContain('203.0.113.10');
  });
});
