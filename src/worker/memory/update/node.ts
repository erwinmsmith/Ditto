import { createNodeScaffold } from "../../node-scaffold.js";
import type { MemoryResources } from "../providers/store.js";
import type { MemoryUpdateInput, MemoryUpdateOutput } from "./types.js";
import { validateUpdate } from "./schema.js";
export async function updateNode(input: MemoryUpdateInput, resources: MemoryResources): Promise<MemoryUpdateOutput> {
  validateUpdate(input);
  return input.memories.length ? resources.store.update(input) : [];
}
export const memoryUpdateNode = createNodeScaffold("MEMORY.UPDATE");
