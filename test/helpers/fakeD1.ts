// A D1Database-compatible adapter backed by Node's built-in SQLite (node:sqlite). Faithful enough
// to run the real db.ts helpers + engine against an in-memory database, so idempotency/retry logic
// is exercised end-to-end without a live Worker.

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

// node:sqlite is a new builtin the bundler doesn't recognize; load it at runtime via require so
// Vite/esbuild never tries to resolve it as a file. The type import above is erased at compile time.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

type Stmt = ReturnType<DatabaseSyncType["prepare"]>;

class FakeStmt {
  private params: unknown[] = [];
  constructor(private readonly stmt: Stmt) {}
  bind(...args: unknown[]): FakeStmt {
    this.params = args;
    return this;
  }
  async run(): Promise<{ meta: { changes: number } }> {
    const r = this.stmt.run(...(this.params as never[]));
    return { meta: { changes: Number(r.changes) } };
  }
  async first<T = unknown>(): Promise<T | null> {
    const row = this.stmt.get(...(this.params as never[]));
    return (row ?? null) as T | null;
  }
  async all<T = unknown>(): Promise<{ results: T[] }> {
    const rows = this.stmt.all(...(this.params as never[]));
    return { results: rows as T[] };
  }
}

class FakeD1 {
  constructor(private readonly db: DatabaseSyncType) {}
  prepare(sql: string): FakeStmt {
    return new FakeStmt(this.db.prepare(sql));
  }
  async batch(stmts: FakeStmt[]): Promise<{ meta: { changes: number } }[]> {
    const out: { meta: { changes: number } }[] = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

/** Create an in-memory DB with every real migration applied, in order, typed as a D1Database. */
export function makeTestDb(): D1Database {
  const db = new DatabaseSync(":memory:");
  const schemaDir = new URL("../../schema/", import.meta.url);
  const files = readdirSync(schemaDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    db.exec(readFileSync(new URL(f, schemaDir), "utf8"));
  }
  return new FakeD1(db) as unknown as D1Database;
}
