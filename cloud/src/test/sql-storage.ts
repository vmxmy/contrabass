import { DatabaseSync } from "node:sqlite";

type TestSqlRow = Record<string, SqlStorageValue>;
type TestSqlBinding = null | number | bigint | string | Uint8Array;

function toSqliteBindings(bindings: unknown[]): TestSqlBinding[] {
  return bindings.map((binding) => {
    if (binding === null || typeof binding === "string" || typeof binding === "number" || typeof binding === "bigint") {
      return binding;
    }
    if (binding instanceof Uint8Array) return binding;
    if (binding instanceof ArrayBuffer) return new Uint8Array(binding);
    throw new TypeError(`Unsupported SQLite binding: ${typeof binding}`);
  });
}

class TestSqlStorageCursor<T extends TestSqlRow> implements SqlStorageCursor<T> {
  readonly columnNames: string[];
  private index = 0;

  constructor(private readonly rows: T[]) {
    this.columnNames = rows.length > 0 ? Object.keys(rows[0]) : [];
  }

  next(): { done?: false; value: T } | { done: true; value?: never } {
    if (this.index >= this.rows.length) return { done: true };
    const value = this.rows[this.index];
    this.index++;
    return { done: false, value };
  }

  toArray(): T[] {
    return [...this.rows];
  }

  one(): T {
    const row = this.rows[0];
    if (row == null) throw new Error("No rows returned");
    return row;
  }

  *raw<U extends SqlStorageValue[]>(): IterableIterator<U> {
    for (const row of this.rows) {
      yield Object.values(row) as U;
    }
  }

  get rowsRead(): number {
    return this.rows.length;
  }

  get rowsWritten(): number {
    return 0;
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.rows[Symbol.iterator]();
  }
}

export function makeTestSqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec<T extends TestSqlRow>(query: string, ...bindings: unknown[]): SqlStorageCursor<T> {
      const trimmed = query.trim().toLowerCase();
      if (bindings.length === 0 && !trimmed.startsWith("select")) {
        db.exec(query);
        return new TestSqlStorageCursor<T>([]);
      }

      const statement = db.prepare(query);
      const sqliteBindings = toSqliteBindings(bindings);
      if (trimmed.startsWith("select")) {
        return new TestSqlStorageCursor<T>(statement.all(...sqliteBindings) as T[]);
      }

      statement.run(...sqliteBindings);
      return new TestSqlStorageCursor<T>([]);
    },
    get databaseSize() {
      return 0;
    },
    Cursor: TestSqlStorageCursor as unknown as typeof SqlStorageCursor,
    Statement: class {} as unknown as typeof SqlStorageStatement,
  };
}
