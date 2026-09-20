import { createNodeScaffold } from "../../node-scaffold.js";
import type { MemoryResources } from "../providers/store.js";
import type { MemorySearchInput, MemorySearchOutput } from "./types.js";
import { validateSearch } from "./schema.js";
export async function searchNode(input: MemorySearchInput, resources: MemoryResources): Promise<MemorySearchOutput> {
  validateSearch(input);
  return resources.search.search(input);
}
export const memorySearchNode = createNodeScaffold("MEMORY.SEARCH");
