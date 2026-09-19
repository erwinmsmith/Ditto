import type { ContextItem, JsonObject } from "../../contracts/common.js";
import { createNodeScaffold } from "../node-scaffold.js";

export const contextUpdateNode = createNodeScaffold("CONTEXT.UPDATE");

/** Minimal deterministic merge for the shared cross-Node ingress boundary. */
export const mergeContextUpdate: import("../node.js").NodeHandler<"CONTEXT.UPDATE"> = async (input) => {
  const items = new Map(input.context.items.map((item) => [item.id, item]));
  for (const id of input.removeIds ?? []) items.delete(id);
  for (const item of input.add ?? []) items.set(item.id, item);
  for (const entry of input.ingress ?? []) {
    const metadata: JsonObject = { ...(entry.metadata ?? {}), sourceNode: entry.sourceNode };
    const item: ContextItem = {
      id: entry.id,
      content: entry.content,
      metadata,
      ...(entry.reference ? { source: entry.reference } : {}),
    };
    items.set(item.id, item);
  }
  return { items: Object.freeze([...items.values()]) };
};
