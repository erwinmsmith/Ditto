import { createNodeScaffold } from "../../node-scaffold.js";
import type { ContextExecution } from "../types.js";
import { ContextError } from "../validation.js";
import { normalizeSource, putItem, snapshotContext } from "../execution.js";
import { validateLoad } from "./schema.js";
import type { ContextLoadInput, ContextLoadOutput } from "./types.js";

export async function loadNode(input: ContextLoadInput, execution: ContextExecution): Promise<ContextLoadOutput> {
  validateLoad(input);
  const items = new Map();
  for (const source of input.sources) putItem(items, normalizeSource(source, execution), execution.policy);
  if (items.size > execution.policy.maxItems) {
    throw new ContextError("ITEM_LIMIT_EXCEEDED", `Context contains ${items.size} items; limit is ${execution.policy.maxItems}`);
  }
  return snapshotContext([...items.values()]);
}

export const contextLoadNode = createNodeScaffold("CONTEXT.LOAD");
