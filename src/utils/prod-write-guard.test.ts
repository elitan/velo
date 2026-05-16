import { describe, expect, test } from 'bun:test';
import { isConfirmedProductionWrite, isReadOnlySql, PRODUCTION_WRITE_CONFIRMATION } from './prod-write-guard';

describe('production write guard', function productionWriteGuard() {
  test('allows clear read-only SQL', function clearReadOnlySql() {
    expect(isReadOnlySql('select * from users limit 1')).toBe(true);
    expect(isReadOnlySql('show server_version')).toBe(true);
    expect(isReadOnlySql('with rows as (select 1) select * from rows')).toBe(true);
    expect(isReadOnlySql('explain select * from users')).toBe(true);
  });

  test('blocks SQL that can write', function writeSql() {
    expect(isReadOnlySql('insert into users (id) values (1)')).toBe(false);
    expect(isReadOnlySql('update users set name = name')).toBe(false);
    expect(isReadOnlySql('select 1; delete from users')).toBe(false);
    expect(isReadOnlySql('explain analyze update users set name = name')).toBe(false);
  });

  test('ignores write words in comments and strings', function commentsAndStrings() {
    expect(isReadOnlySql("-- delete all rows\nselect 'update users' as note")).toBe(true);
  });

  test('requires exact production confirmation', function confirmationPhrase() {
    expect(isConfirmedProductionWrite(PRODUCTION_WRITE_CONFIRMATION)).toBe(true);
    expect(isConfirmedProductionWrite(` ${PRODUCTION_WRITE_CONFIRMATION.toUpperCase()} `)).toBe(true);
    expect(isConfirmedProductionWrite('write prod')).toBe(false);
  });
});
