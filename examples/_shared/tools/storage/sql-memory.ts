import { randomUUID } from "node:crypto";
import { MemoryError, type MemoryItem, type MemoryStore, type MemorySearchProvider } from "@codesoul-co/ditto/worker/memory";

export type Row = { id: string; memory_key: string | null; content: string; metadata: string | null };
export type Rows = (sql: string, values?: unknown[]) => Promise<Row[]>;
export interface SqlDatabase {
  dialect: "sqlite" | "postgres" | "mysql";
  rows: Rows;
  transaction<T>(operation: (rows: Rows) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Application adapter: parameterized SQL and explicit JSON mapping, no ORM. */
export function createSqlMemoryStore(database: SqlDatabase, table: string, idempotentKeys = false): MemoryStore & MemorySearchProvider {
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
    const clauses: string[] = [], values: unknown[] = [];
    for (const [key, v] of Object.entries(value)) {
      if (!["key", "namespace", "kind"].includes(key) || typeof v !== "string") throw new MemoryError("INVALID_INPUT", "SQL filter supports string key, namespace and kind");
      const field = key === "key" ? "memory_key" : database.dialect === "postgres" ? `(metadata::jsonb ->> '${key}')` : database.dialect === "mysql" ? `JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.${key}'))` : `json_extract(metadata, '$.${key}')`;
      clauses.push(`${field} = ?`); values.push(v);
    }
    return { sql: clauses.join(" AND "), values };
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
      if (limit === 0) return { items: [] };
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
        const saved: MemoryItem[] = [];
        for (const item of items) {
          if (idempotentKeys && item.key) {
            const [existing] = await rows(`SELECT * FROM ${table} WHERE memory_key = ?${lock}`, [item.key]);
            if (existing) {
              if (existing.content !== json(item.content) || existing.metadata !== (item.metadata === undefined ? null : json(item.metadata))) throw new MemoryError("INVALID_INPUT", "Memory key conflicts with existing content");
              saved.push(map(existing)); continue;
            }
          }
          await rows(`INSERT INTO ${table} (id, memory_key, content, metadata) VALUES (?, ?, ?, ?)`,
            [item.id, item.key ?? null, json(item.content), item.metadata === undefined ? null : json(item.metadata)]);
          saved.push(item);
        }
        return saved;
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
