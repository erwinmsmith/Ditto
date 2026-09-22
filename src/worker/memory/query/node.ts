import type { MemoryCallOptions } from "../types.js";
import { createNodeScaffold } from "../../node-scaffold.js";
import type { MemoryResources } from "../providers/store.js";
import type { MemoryQueryInput, MemoryQueryOutput } from "./types.js";
import { validateQuery } from "./schema.js";
export async function queryNode(input: MemoryQueryInput, resources: MemoryResources, options: MemoryCallOptions = {}): Promise<MemoryQueryOutput> {
  validateQuery(input);
  return resources.store.query(input, options);
}
export const memoryQueryNode = createNodeScaffold("MEMORY.QUERY");
