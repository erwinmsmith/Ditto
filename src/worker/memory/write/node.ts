import type { MemoryCallOptions } from "../types.js";
import { createNodeScaffold } from "../../node-scaffold.js";
import type { MemoryResources } from "../providers/store.js";
import type { MemoryWriteInput, MemoryWriteOutput } from "./types.js";
import { validateWrite } from "./schema.js";
export async function writeNode(input: MemoryWriteInput, resources: MemoryResources, options: MemoryCallOptions = {}): Promise<MemoryWriteOutput> {
  validateWrite(input);
  return input.memories.length ? resources.store.write(input, options) : [];
}
export const memoryWriteNode = createNodeScaffold("MEMORY.WRITE");
