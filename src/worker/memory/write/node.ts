import { createNodeScaffold } from "../../node-scaffold.js";
import type { MemoryResources } from "../providers/store.js";
import type { MemoryWriteInput, MemoryWriteOutput } from "./types.js";
import { validateWrite } from "./schema.js";
export async function writeNode(input: MemoryWriteInput, resources: MemoryResources): Promise<MemoryWriteOutput> {
  validateWrite(input);
  return input.memories.length ? resources.store.write(input) : [];
}
export const memoryWriteNode = createNodeScaffold("MEMORY.WRITE");
