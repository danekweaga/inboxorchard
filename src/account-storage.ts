const migrations = import.meta.glob<string>("../schema/*.sql", { eager: true, query: "?raw", import: "default" });

type Statement = { sql: string; values: SqlStorageValue[] };
type Result = { results: Record<string, unknown>[]; success: true; meta: { changes: number } };

/** Private SQLite storage, provisioned by Cloudflare on first use for each Instagram ID. */
export class InstagramAccountStorage {
  private initialized = false;
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const statements: Statement[] = await request.json();
    const storage = this.state.storage;
    const sql = storage.sql;
    const result = storage.transactionSync(() => {
      if (!this.initialized) {
        sql.exec("CREATE TABLE IF NOT EXISTS account_schema (name TEXT PRIMARY KEY)");
        for (const [name, migration] of Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b))) {
        if (sql.exec("SELECT 1 FROM account_schema WHERE name=?", name).toArray().length) continue;
        sql.exec(migration.replace(/^PRAGMA (foreign_keys|optimize)[^;]*;/gim, ""));
        sql.exec("INSERT INTO account_schema VALUES (?)", name);
        }
      }
      return statements.map(s => {
        const results = sql.exec(s.sql, ...s.values).toArray();
        const changes = Number(sql.exec("SELECT changes() AS n").one().n);
        return { results, success: true, meta: { changes } };
      });
    });
    this.initialized = true;
    return Response.json(result);
  }
}

export function accountDatabase(namespace: DurableObjectNamespace, id: string): D1Database {
  const stub = namespace.get(namespace.idFromName(id));
  async function execute(statements: Statement[]): Promise<Result[]> {
    const response = await stub.fetch("https://storage.internal/", { method: "POST", body: JSON.stringify(statements) });
    if (!response.ok) throw new Error("Instagram workspace database request failed");
    return response.json();
  }
  class Prepared implements Statement {
    constructor(readonly sql: string, readonly values: SqlStorageValue[] = []) {}
    bind(...values: SqlStorageValue[]) { return new Prepared(this.sql, values); }
    async all() { return (await execute([this]))[0]!; }
    run() { return this.all(); }
    async first(column?: string) {
      const row = (await this.all()).results[0];
      return column ? row?.[column] ?? null : row ?? null;
    }
  }
  return { prepare: (sql: string) => new Prepared(sql), batch: execute } as unknown as D1Database;
}
