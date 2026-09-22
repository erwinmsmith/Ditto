import { createNodeScaffold } from "../../node-scaffold.js";
import type { ContextExecution } from "../types.js";
import { check, contextItem, inlineBytes, ContextError } from "../validation.js";
import { checkedItem, normalizeSource, putItem, snapshotContext } from "../execution.js";
import { validateLoad } from "./schema.js";
import type { ContextLoadInput, ContextLoadOutput } from "./types.js";

export async function loadNode(input: ContextLoadInput, execution: ContextExecution): Promise<ContextLoadOutput> {
  validateLoad(input);
  if (input.resolveReferences) check(execution.services.referenceResolver, "Reference resolver is not configured", "RESOLVER_UNAVAILABLE");
  const items = new Map();
  for (const source of input.sources) {
    execution.signal?.throwIfAborted();
    let item = normalizeSource(source, execution);
    if (input.resolveReferences && "uri" in source && !("id" in source) && !("role" in source)) {
      const content = await execution.services.referenceResolver!.resolve(source, execution);
      execution.signal?.throwIfAborted();
      const resolved = { ...item, content };
      try { contextItem(resolved); }
      catch { throw new ContextError("INVALID_PROVIDER_OUTPUT", "Resolver returned invalid content"); }
      check(inlineBytes(content) <= execution.policy.maxInlineBytes, "Resolved content exceeds inline byte limit", "INLINE_LIMIT_EXCEEDED");
      item = checkedItem(resolved, execution);
    }
    putItem(items, item, execution.policy);
  }
  if (items.size > execution.policy.maxItems) {
    throw new ContextError("ITEM_LIMIT_EXCEEDED", `Context contains ${items.size} items; limit is ${execution.policy.maxItems}`);
  }
  return snapshotContext([...items.values()]);
}

export const contextLoadNode = createNodeScaffold("CONTEXT.LOAD");
