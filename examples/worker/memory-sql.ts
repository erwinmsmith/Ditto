import { randomUUID } from "node:crypto";
import { MemoryError, type MemoryItem, type MemoryStore, type MemorySearchProvider } from "@ditto/core/worker/memory";
import { exampleSdk, runMemoryExample } from "./shared.ts";

type Row = { id: string; memory_key: string | null; content: string; metadata: string | null };
type Rows = (sql: string, values?: unknown[]) => Promise<Row[]>;
export interface SqlDatabase {
  dialect: "sqlite" | "postgres" | "mysql";
  rows: Rows;
  transaction<T>(operation: (rows: Rows) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Application adapter: parameterized SQL and explicit JSON mapping, no ORM. */
export function createSqlMemoryStore(database: SqlDatabase, table: string): MemoryStore & MemorySearchProvider {
  if (!/^[a-z][a-z0-9_]*$/.test(table)) throw new Error("Invalid example table name");
  const lock = database.dialect === "sqlite" ? "" : " FOR UPDATE";
  const map = (row: Row): MemoryItem => ({ id: row.id, content: JSON.parse(row.content),
    ...(row.memory_key === null ? {} : { key: row.memory_key }),
    ...(row.metadata === null ? {} : { metadata: JSON.parse(row.metadata) }),
  });
  const json = (value: unknown) => {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new MemoryError("INVALID_INPUT", "SQL example requires JSON content");
    return encoded;
  };
  const list = (values: readonly string[]) => values.map(() => "?").join(",");
  const filter = (value?: Record<string, unknown>): { sql: string; values: unknown[] } => {
    if (!value || !Object.keys(value).length) return { sql: "1=1", values: [] };
    if (Object.keys(value).some(key => key !== "key") || typeof value.key !== "string") {
      throw new MemoryError("INVALID_INPUT", "SQL example supports filter: { key: string }");
    }
    return { sql: "memory_key = ?", values: [value.key] };
  };
  return {
    async get(input) {
      const clauses: string[] = [], values: unknown[] = [];
      if (input.ids?.length) { clauses.push(`id IN (${list(input.ids)})`); values.push(...input.ids); }
      if (input.keys?.length) { clauses.push(`memory_key IN (${list(input.keys)})`); values.push(...input.keys); }
      return clauses.length ? (await database.rows(`SELECT * FROM ${table} WHERE ${clauses.join(" OR ")} ORDER BY id`, values)).map(map) : [];
    },
    async query(input) {
      if (input.orderBy?.some(order => order.field !== "id" || (order.direction ?? "asc") !== "asc")) {
        throw new MemoryError("INVALID_INPUT", "SQL example supports ORDER BY id ASC");
      }
      const where = filter(input.filter), limit = input.limit ?? 100;
      const rows = await database.rows(`SELECT * FROM ${table} WHERE ${where.sql}${input.cursor ? " AND id > ?" : ""} ORDER BY id LIMIT ?`,
        [...where.values, ...(input.cursor ? [input.cursor] : []), limit + 1]);
      const items = rows.slice(0, limit).map(map);
      return { items, ...(rows.length > limit ? { nextCursor: items.at(-1)!.id } : {}) };
    },
    async search(input) {
      if (typeof input.query !== "string" || (input.strategy && input.strategy !== "keyword") || Object.keys(input.options ?? {}).length) {
        throw new MemoryError("INVALID_INPUT", "SQL example supports string keyword queries without options");
      }
      const where = filter(input.filter);
      const query = input.query.toLowerCase().replace(/[!%_]/g, char => `!${char}`);
      const rows = await database.rows(`SELECT * FROM ${table} WHERE ${where.sql} AND LOWER(content) LIKE ? ESCAPE '!' ORDER BY id LIMIT ?`,
        [...where.values, `%${query}%`, input.limit ?? 10]);
      return rows.map(row => ({ memory: map(row) })); // Database substring matching, not vector ranking.
    },
    async write(input) {
      const items = input.memories.map(memory => ({ ...memory, id: randomUUID() }));
      return database.transaction(async rows => {
        for (const item of items) await rows(`INSERT INTO ${table} (id, memory_key, content, metadata) VALUES (?, ?, ?, ?)`,
          [item.id, item.key ?? null, json(item.content), item.metadata === undefined ? null : json(item.metadata)]);
        return items;
      });
    },
    async update(input) {
      if (!input.memories.length) return [];
      return database.transaction(async rows => {
        const ids = input.memories.map(item => item.id);
        const existing = new Map((await rows(`SELECT * FROM ${table} WHERE id IN (${list(ids)}) ORDER BY id${lock}`, ids)).map(row => [row.id, map(row)]));
        if (existing.size !== ids.length) throw new MemoryError("NOT_FOUND", "Update target does not exist");
        const items = input.memories.map(change => ({ ...existing.get(change.id)!, ...change }));
        for (const item of items) await rows(`UPDATE ${table} SET content = ?, metadata = ? WHERE id = ?`,
          [json(item.content), item.metadata === undefined ? null : json(item.metadata), item.id]);
        return items;
      });
    },
    async delete(input) {
      if (!input.ids.length) return { deleted: [] };
      return database.transaction(async rows => {
        const existing = await rows(`SELECT * FROM ${table} WHERE id IN (${list(input.ids)}) ORDER BY id${lock}`, [...input.ids]);
        const ids = existing.map(row => row.id);
        if (ids.length) await rows(`DELETE FROM ${table} WHERE id IN (${list(ids)})`, ids);
        return { deleted: ids };
      });
    },
  };
}

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
