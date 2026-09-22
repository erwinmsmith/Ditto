import type { MemoryCallOptions } from "../types.js";
import { createNodeScaffold } from "../../node-scaffold.js";
import type { MemoryResources } from "../providers/store.js";
import type { MemorySearchInput, MemorySearchOutput } from "./types.js";
import { MemoryError } from "../validation.js";
import { validateSearch } from "./schema.js";
export async function searchNode(input: MemorySearchInput, resources: MemoryResources, options: MemoryCallOptions = {}): Promise<MemorySearchOutput> {
  validateSearch(input);
  const provider = resources.search ?? resources.store;
  if (typeof provider.search !== "function") throw new MemoryError("SEARCH_UNAVAILABLE", "Memory search is not configured");
  return provider.search(input, options);
}
export const memorySearchNode = createNodeScaffold("MEMORY.SEARCH");
