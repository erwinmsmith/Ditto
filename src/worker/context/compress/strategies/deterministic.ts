import type { Context, ContextItem } from "../../../../contracts/common.js";
import type { ContextExecution } from "../../types.js";
import {
  booleanMetadata, estimateTokens, numericMetadata, snapshotContext,
} from "../../execution.js";
import { ContextError } from "../../validation.js";
import type { ContextCompressInput } from "../types.js";

interface ItemGroup {
  readonly key: string;
  readonly items: readonly ContextItem[];
  readonly firstIndex: number;
  readonly protected: boolean;
  readonly keepScore: number;
  readonly tokens: number;
}

export function isProtectedContextItem(item: ContextItem): boolean {
  return booleanMetadata(item, "protected")
    || booleanMetadata(item, "safety")
    || booleanMetadata(item, "currentGoal")
    || booleanMetadata(item, "pending")
    || item.metadata?.role === "system";
}

function correlationKey(item: ContextItem): string {
  const callId = item.metadata?.callId;
  return typeof callId === "string" && callId ? `call:${callId}` : `item:${item.id}`;
}

async function groups(items: readonly ContextItem[], execution: ContextExecution, countTokens: boolean): Promise<readonly ItemGroup[]> {
  const grouped = new Map<string, { items: ContextItem[]; firstIndex: number }>();
  items.forEach((item, index) => {
    const key = correlationKey(item);
    const existing = grouped.get(key);
    if (existing) existing.items.push(item);
    else grouped.set(key, { items: [item], firstIndex: index });
  });
  return Promise.all([...grouped.entries()].map(async ([key, group]) => ({
    key,
    items: group.items,
    firstIndex: group.firstIndex,
    protected: group.items.some(isProtectedContextItem),
    keepScore: Math.max(...group.items.map((item, index) =>
      numericMetadata(item, "priority") * 100
      + numericMetadata(item, "relevance") * 10
      + (booleanMetadata(item, "retrievable") ? -10 : 0)
      + (group.firstIndex + index) / Math.max(1, items.length))),
    tokens: countTokens ? (await Promise.all(group.items.map(item => estimateTokens(item.content, execution))))
      .reduce((sum, value) => sum + value, 0) : 0,
  })));
}

/** Deterministic budget enforcement. Tool-correlated entries are atomic groups. */
export async function deterministicCompress(
  input: ContextCompressInput,
  execution: ContextExecution,
): Promise<Context> {
  const maxItems = Math.min(input.maxItems ?? execution.policy.maxItems, execution.policy.maxItems);
  const maxTokens = execution.policy.maxTokens === undefined
    ? input.maxTokens ?? Number.POSITIVE_INFINITY
    : Math.min(input.maxTokens ?? execution.policy.maxTokens, execution.policy.maxTokens);
  const all = await groups(input.context.items, execution, Number.isFinite(maxTokens));
  const required = all.filter(group => group.protected);
  const requiredItems = required.reduce((sum, group) => sum + group.items.length, 0);
  const requiredTokens = required.reduce((sum, group) => sum + group.tokens, 0);
  if (requiredItems > maxItems || requiredTokens > maxTokens) {
    throw new ContextError("BUDGET_UNSATISFIABLE", "Protected Context items exceed the requested budget");
  }
  const kept = new Set(all.map(group => group.key));
  let itemCount = input.context.items.length;
  let tokenCount = all.reduce((sum, group) => sum + group.tokens, 0);
  const removable = all.filter(group => !group.protected)
    .sort((a, b) => a.keepScore - b.keepScore || a.firstIndex - b.firstIndex || a.key.localeCompare(b.key));
  for (const group of removable) {
    if (itemCount <= maxItems && tokenCount <= maxTokens) break;
    kept.delete(group.key);
    itemCount -= group.items.length;
    tokenCount -= group.tokens;
  }
  return snapshotContext(input.context.items.filter(item => kept.has(correlationKey(item))));
}
