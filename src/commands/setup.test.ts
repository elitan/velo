import { describe, expect, test } from 'bun:test';
import { getSetupUser } from './setup';

describe('setup user detection', function () {
  test('uses regular user', function () {
    const user = getSetupUser({ USER: 'alice' }, function () {
      return 1000;
    });

    expect(user).toBe('alice');
  });

  test('rejects root user', function () {
    const user = getSetupUser({ USER: 'root' }, function () {
      return 0;
    });

    expect(user).toBeNull();
  });

  test('rejects sudo even when USER is preserved', function () {
    const user = getSetupUser({ USER: 'alice', SUDO_USER: 'alice' }, function () {
      return 0;
    });

    expect(user).toBeNull();
  });

  test('rejects missing user', function () {
    const user = getSetupUser({}, function () {
      return 1000;
    });

    expect(user).toBeNull();
  });
});
