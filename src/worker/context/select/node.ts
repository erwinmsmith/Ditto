import { createNodeScaffold } from "../../node-scaffold.js";
import type { ContextItem } from "../../../contracts/common.js";
import type { ContextExecution } from "../types.js";
import { checkedItem, estimateTokens, snapshotContext } from "../execution.js";
import { check, ContextError, contextItem } from "../validation.js";
import { defaultSelect } from "./strategies/default.js";
import { validateSelect } from "./schema.js";
import type { ContextSelectInput, ContextSelectOutput } from "./types.js";

async function candidates(input: ContextSelectInput, execution: ContextExecution): Promise<readonly ContextItem[]> {
  const kind = input.strategy?.kind ?? "default";
  if (kind === "default") return defaultSelect(input);
  const selector = kind === "rag" ? execution.services.ragStrategy : execution.services.selector;
  if (!selector) throw new ContextError("STRATEGY_UNAVAILABLE", `${kind} Context selection is not configured`);
  return selector.select(input, execution);
}

export async function selectNode(input: ContextSelectInput, execution: ContextExecution): Promise<ContextSelectOutput> {
  validateSelect(input);
  const raw = await candidates(input, execution);
  check(Array.isArray(raw), "Selector must return an array", "INVALID_PROVIDER_OUTPUT");
  const seen = new Set<string>();
  const selected: ContextItem[] = [];
  const limit = Math.min(input.limit ?? execution.policy.maxItems, execution.policy.maxItems);
  const tokenLimit = execution.policy.maxTokens === undefined
    ? input.maxTokens
    : Math.min(input.maxTokens ?? execution.policy.maxTokens, execution.policy.maxTokens);
  let tokens = 0;
  for (const [index, value] of raw.entries()) {
    try { contextItem(value, `selection[${index}]`); }
    catch { throw new ContextError("INVALID_PROVIDER_OUTPUT", "Selector returned an invalid Context item"); }
    if (seen.has(value.id)) continue;
    seen.add(value.id);
    if (selected.length >= limit) break;
    const item = checkedItem(value, execution);
    const itemTokens = tokenLimit === undefined ? 0 : await estimateTokens(item.content, execution);
    if (tokenLimit !== undefined && tokens + itemTokens > tokenLimit) continue;
    tokens += itemTokens;
    selected.push(item);
  }
  const context = snapshotContext(selected);
  return Object.freeze({
    purpose: input.purpose,
    context,
    selectedItemIds: Object.freeze(context.items.map(item => item.id)),
  });
}

export const contextSelectNode = createNodeScaffold("CONTEXT.SELECT");
