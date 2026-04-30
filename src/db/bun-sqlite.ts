import { Database } from 'bun:sqlite';

export class BunSqliteDatabase {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
  }

  close(): void {
    this.db.close();
  }

  prepare(sql: string): BunSqliteStatement {
    return new BunSqliteStatement(sql, this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }
}

class BunSqliteStatement {
  readonly reader: boolean;

  constructor(
    private sql: string,
    private statement: ReturnType<Database['prepare']>
  ) {
    this.reader = isReadStatement(sql);
  }

  all(parameters: ReadonlyArray<unknown>): unknown[] {
    return (this.statement.all as (...args: unknown[]) => unknown[])(parameters);
  }

  run(parameters: ReadonlyArray<unknown>): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return (this.statement.run as (...args: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint })(parameters);
  }

  iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown> {
    return (this.statement.iterate as (...args: unknown[]) => IterableIterator<unknown>)(parameters);
  }
}

function isReadStatement(sql: string): boolean {
  const firstWord = sql.trimStart().split(/\s+/, 1)[0]?.toLowerCase();
  return firstWord === 'select' || firstWord === 'pragma' || firstWord === 'with';
}
