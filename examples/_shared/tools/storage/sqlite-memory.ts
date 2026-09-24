import { DatabaseSync } from "node:sqlite";
import { createSqlMemoryStore, type Rows, type SqlDatabase, type Row } from "./sql-memory.ts";

/** File-backed MEMORY adapter; no application task tables or Core internals. */
export function openSqliteMemory(filename: string) {
  if (filename === ":memory:") throw new Error("Use a persistent MEMORY database path");
  const client = new DatabaseSync(filename);
  client.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, memory_key TEXT UNIQUE, content TEXT NOT NULL, metadata TEXT);`);
  const rows: Rows = async (sql, values = []) => {
    const statement = client.prepare(sql);
    if (statement.columns().length) return statement.all(...values as (string | number | null)[]) as Row[];
    statement.run(...values as (string | number | null)[]); return [];
  };
  let tail = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = tail.then(operation); tail = pending.then(() => {}, () => {}); return pending;
  };
  const database: SqlDatabase = {
    dialect: "sqlite", rows: (sql, values) => serial(() => rows(sql, values)),
    transaction: operation => serial(async () => {
      await rows("BEGIN IMMEDIATE");
      try { const result = await operation(rows); await rows("COMMIT"); return result; }
      catch (error) { await rows("ROLLBACK"); throw error; }
    }),
    async close() { await tail; client.close(); },
  };
  return { store: createSqlMemoryStore(database, "memories", true), close: () => database.close() };
}
