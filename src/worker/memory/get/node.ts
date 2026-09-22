import type { MemoryCallOptions } from "../types.js";
import { createNodeScaffold } from "../../node-scaffold.js";
import type { MemoryResources } from "../providers/store.js";
import type { MemoryGetInput, MemoryGetOutput } from "./types.js";
import { validateOutput } from "../validation.js";
import { validateGet } from "./schema.js";
export async function getNode(input: MemoryGetInput, resources: MemoryResources, options: MemoryCallOptions = {}): Promise<MemoryGetOutput> {
  validateGet(input);
  const ids = [...new Set(input.ids ?? [])];
  const keys = [...new Set(input.keys ?? [])];
  if (!ids.length && !keys.length) return [];
  const items = await resources.store.get({ ids, keys }, options);
  validateOutput("get", items);
  const byId = new Map(items.map(item => [item.id, item]));
  const byKey = new Map(items.filter(item => item.key !== undefined).map(item => [item.key!, item]));
  const selected = new Map<string, (typeof items)[number]>();
  for (const item of [...ids.map(id => byId.get(id)), ...keys.map(key => byKey.get(key))]) {
    if (item) selected.set(item.id, item);
  }
  return [...selected.values()];
}
export const memoryGetNode = createNodeScaffold("MEMORY.GET");
