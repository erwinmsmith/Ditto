import { createNodeScaffold } from "../../node-scaffold.js";
import type { MemoryResources } from "../providers/store.js";
import type { MemoryQueryInput, MemoryQueryOutput } from "./types.js";
import { validateQuery } from "./schema.js";
export async function queryNode(input: MemoryQueryInput, resources: MemoryResources): Promise<MemoryQueryOutput> {
  validateQuery(input);
  return resources.store.query(input);
}
export const memoryQueryNode = createNodeScaffold("MEMORY.QUERY");
