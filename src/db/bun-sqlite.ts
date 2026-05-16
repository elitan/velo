import { Database } from 'bun:sqlite';
import { protectDatabaseFiles } from './state-permissions';

export class BunSqliteDatabase {
  private db: Database;

  constructor(private databasePath: string) {
    this.db = new Database(databasePath);
    protectDatabaseFiles(databasePath);
  }

  close(): void {
    this.db.close();
  }

  prepare(sql: string): BunSqliteStatement {
    return new BunSqliteStatement(sql, this.db.prepare(sql), this.databasePath);
  }

  exec(sql: string): void {
    this.db.exec(sql);
    protectDatabaseFiles(this.databasePath);
  }
}

class BunSqliteStatement {
  readonly reader: boolean;

  constructor(
    private sql: string,
    private statement: ReturnType<Database['prepare']>,
    private databasePath: string
  ) {
    this.reader = isReadStatement(sql);
  }

  all(parameters: ReadonlyArray<unknown>): unknown[] {
    return (this.statement.all as (...args: unknown[]) => unknown[])(parameters);
  }

  run(parameters: ReadonlyArray<unknown>): { changes: number | bigint; lastInsertRowid: number | bigint } {
    const result = (this.statement.run as (...args: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint })(parameters);
    protectDatabaseFiles(this.databasePath);
    return result;
  }

  iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown> {
    return (this.statement.iterate as (...args: unknown[]) => IterableIterator<unknown>)(parameters);
  }
}

function isReadStatement(sql: string): boolean {
  const firstWord = sql.trimStart().split(/\s+/, 1)[0]?.toLowerCase();
  return firstWord === 'select' || firstWord === 'pragma' || firstWord === 'with' || /\breturning\b/i.test(sql);
}
