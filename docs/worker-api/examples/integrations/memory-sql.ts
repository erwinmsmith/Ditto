import { randomUUID } from "node:crypto";
import { exampleSdk, runMemoryExample } from "./shared.ts";

import { createSqlMemoryStore, type SqlDatabase, type Rows, type Row } from "../../../../examples/_shared/tools/storage/sql-memory.ts";
export { createSqlMemoryStore, type SqlDatabase } from "../../../../examples/_shared/tools/storage/sql-memory.ts";

async function transact<T>(rows: Rows, operation: (rows: Rows) => Promise<T>, begin = "BEGIN"): Promise<T> {
  await rows(begin);
  try { const value = await operation(rows); await rows("COMMIT"); return value; }
  catch (error) { await rows("ROLLBACK"); throw error; }
}

export async function openSqlDatabase(dialect: SqlDatabase["dialect"]): Promise<SqlDatabase> {
  if (dialect === "sqlite") {
    const { DatabaseSync } = await import("node:sqlite");
    const client = new DatabaseSync(":memory:");
    const rows: Rows = async (sql, values = []) => {
      const statement = client.prepare(sql);
      if (statement.columns().length) return statement.all(...values as (string | number | null)[]) as Row[];
      statement.run(...values as (string | number | null)[]); return [];
    };
    // Serialize all access to this one connection, including reads during a transaction.
    let tail = Promise.resolve();
    const serial = <T>(operation: () => Promise<T>): Promise<T> => {
      const pending = tail.then(operation); tail = pending.then(() => {}, () => {}); return pending;
    };
    return { dialect, rows: (sql, values) => serial(() => rows(sql, values)),
      transaction: operation => serial(() => transact(rows, operation, "BEGIN IMMEDIATE")),
      async close() { await tail; client.close(); },
    };
  }
  if (dialect === "postgres") {
    type Client = { query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>; release(): void };
    const { Pool } = exampleSdk("pg") as { Pool: new (config: object) => { connect(): Promise<Client>; query: Client["query"]; end(): Promise<void> } };
    const url = process.env.DITTO_WORKER_MEMORY_POSTGRES_URL;
    if (!url) throw new Error("Set DITTO_WORKER_MEMORY_POSTGRES_URL");
    const pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5000 });
    const bind = (sql: string) => { let index = 0; return sql.replace(/\?/g, () => `$${++index}`); };
    return { dialect, rows: async (sql, values) => (await pool.query(bind(sql), values)).rows,
      async transaction(operation) {
        const client = await pool.connect();
        try { return await transact(async (sql, values) => (await client.query(bind(sql), values)).rows, operation); }
        finally { client.release(); }
      }, close: () => pool.end(),
    };
  }
  type Client = { query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>; release(): void };
  const { createPool } = exampleSdk("mysql2/promise") as { createPool(config: object): { getConnection(): Promise<Client>; query: Client["query"]; end(): Promise<void> } };
  const url = process.env.DITTO_WORKER_MEMORY_MYSQL_URL;
  if (!url) throw new Error("Set DITTO_WORKER_MEMORY_MYSQL_URL");
  const pool = createPool({ uri: url, connectionLimit: 4, connectTimeout: 5000 });
  const rows = async (client: Pick<Client, "query">, sql: string, values?: unknown[]): Promise<Row[]> => {
    const [output] = await client.query(sql, values); return Array.isArray(output) ? output as Row[] : [];
  };
  return { dialect, rows: (sql, values) => rows(pool, sql, values),
    async transaction(operation) {
      const client = await pool.getConnection();
      try { return await transact((sql, values) => rows(client, sql, values), operation); }
      finally { client.release(); }
    }, close: () => pool.end(),
  };
}

export async function main(dialect = process.argv[2] ?? "sqlite") {
  if (dialect !== "sqlite" && dialect !== "postgres" && dialect !== "mysql") throw new Error("Choose sqlite, postgres or mysql");
  const database = await openSqlDatabase(dialect);
  const table = `ditto_example_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  try {
    await database.rows(`CREATE TABLE ${table} (id VARCHAR(36) PRIMARY KEY, memory_key VARCHAR(255), content TEXT NOT NULL, metadata TEXT)`);
    created = true;
    await database.rows(`CREATE INDEX ${table}_key ON ${table} (memory_key)`);
    await runMemoryExample({ store: createSqlMemoryStore(database, table) }, "language", [
      { key: "preference", content: { text: "Preferred language is Chinese" }, metadata: { source: "user" } },
      { key: "topic", content: { text: "Worker API examples" } },
    ]);
  } finally {
    try { if (created) await database.rows(`DROP TABLE ${table}`); }
    finally { await database.close(); }
  }
}

if (import.meta.main) await main();
