import type { MemoryCallOptions } from "../types.js";
import { createNodeScaffold } from "../../node-scaffold.js";
import type { MemoryResources } from "../providers/store.js";
import type { MemoryDeleteInput, MemoryDeleteOutput } from "./types.js";
import { validateDelete } from "./schema.js";
export async function deleteNode(input: MemoryDeleteInput, resources: MemoryResources, options: MemoryCallOptions = {}): Promise<MemoryDeleteOutput> {
  validateDelete(input);
  const ids = [...new Set(input.ids)];
  return ids.length ? resources.store.delete({ ids }, options) : { deleted: [] };
}
export const memoryDeleteNode = createNodeScaffold("MEMORY.DELETE");
