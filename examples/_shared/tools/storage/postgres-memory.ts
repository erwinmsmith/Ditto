import { createRequire } from "node:module";
import { createSqlMemoryStore, type SqlDatabase, type Row } from "./sql-memory.ts";
export async function openPostgresMemory(url: string, table = "agent_memories") {
  if (!/^[a-z][a-z0-9_]*$/.test(table)) throw new Error("Invalid Memory table");
  type Client = { query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>; release(): void };
  const require = createRequire(new URL("./dependencies/package.json", import.meta.url));
  const { Pool } = require("pg") as { Pool: new (config: object) => { query: Client["query"]; connect(): Promise<Client>; end(): Promise<void> } };
  const pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  const bind = (sql: string) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const database: SqlDatabase = { dialect: "postgres", rows: async (sql, values) => (await pool.query(bind(sql), values)).rows,
    async transaction(operation) { const client = await pool.connect();
      try { await client.query("BEGIN"); try { const result = await operation(async (sql, values) => (await client.query(bind(sql), values)).rows); await client.query("COMMIT"); return result; } catch (error) { await client.query("ROLLBACK"); throw error; } }
      finally { client.release(); }
    }, close: () => pool.end(),
  };
  try { await database.rows(`CREATE TABLE IF NOT EXISTS ${table} (id VARCHAR(36) PRIMARY KEY, memory_key TEXT UNIQUE, content TEXT NOT NULL, metadata TEXT)`); }
  catch (error) { await database.close(); throw error; }
  return { store: createSqlMemoryStore(database, table, true), close: () => database.close() };
}
