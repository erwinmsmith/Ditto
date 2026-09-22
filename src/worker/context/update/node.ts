import { createNodeScaffold } from "../../node-scaffold.js";
import type { ContextItem, JsonObject } from "../../../contracts/common.js";
import type { ContextExecution } from "../types.js";
import { checkedItem, putItem, snapshotContext } from "../execution.js";
import { ContextError } from "../validation.js";
import { validateUpdate } from "./schema.js";
import type { ContextUpdateInput, ContextUpdateOutput } from "./types.js";

export async function updateNode(input: ContextUpdateInput, execution: ContextExecution): Promise<ContextUpdateOutput> {
  validateUpdate(input);
  const items = new Map<string, ContextItem>(input.context.items.map(item => [item.id, checkedItem(item, execution)]));
  for (const id of input.removeIds ?? []) {
    if (!items.delete(id) && execution.policy.missingRemoval === "reject") {
      throw new ContextError("MISSING_ITEM", `Cannot remove missing Context item: ${id}`);
    }
  }
  for (const item of input.add ?? []) putItem(items, checkedItem(item, execution), execution.policy);
  for (const entry of input.ingress ?? []) {
    const metadata: JsonObject = { ...(entry.metadata ?? {}), sourceNode: entry.sourceNode };
    putItem(items, checkedItem({
      id: entry.id,
      content: entry.content,
      metadata,
      ...(entry.reference === undefined ? {} : { source: entry.reference }),
    }, execution), execution.policy);
  }
  if (items.size > execution.policy.maxItems) {
    throw new ContextError("ITEM_LIMIT_EXCEEDED", `Context contains ${items.size} items; limit is ${execution.policy.maxItems}`);
  }
  return snapshotContext([...items.values()]);
}

export const contextUpdateNode = createNodeScaffold("CONTEXT.UPDATE");
