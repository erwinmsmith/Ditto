import type { Context } from "../../contracts/common.js";
import type { ContextScope, ContextStateStore, StoredContext } from "./types.js";
import { context, ContextError, nonempty, object, check } from "./validation.js";
import { snapshotContext, stableContextId } from "./execution.js";

/** A scope addresses cached working state; it is not an authorization credential. */
export interface ContextStateInput {
  readonly scope: ContextScope;
  readonly expectedVersion?: string;
}
export type ContextRequest<T> = T | (Omit<T, "context"> & ContextStateInput & { readonly context?: never });

export function contextScopeKey(scope: ContextScope): string {
  const value = object(scope, "scope");
  const keys = ["sessionId", "turnId", "invocationId"] as const;
  check(Object.keys(value).every(key => keys.includes(key as typeof keys[number])), "Unknown Context scope field");
  check(keys.some(key => value[key] !== undefined), "Context scope must contain an identifier");
  for (const key of keys) if (value[key] !== undefined) nonempty(value[key], `scope.${key}`);
  return stableContextId("scope", keys.map(key => value[key] ?? null));
}

export function checkedStoredContext(value: unknown): StoredContext {
  try {
    const stored = object(value, "stored context");
    nonempty(stored.version, "version");
    context(stored.context);
    return Object.freeze({ version: stored.version, context: snapshotContext(stored.context.items) });
  } catch {
    throw new ContextError("INVALID_STATE", "Context store returned invalid state");
  }
}

export async function readContextState(store: ContextStateStore, scope: ContextScope): Promise<StoredContext | undefined> {
  const value = await store.get(scope);
  return value === undefined ? undefined : checkedStoredContext(value);
}

export function requireContextState(stored: StoredContext | undefined): Context {
  if (!stored) throw new ContextError("CONTEXT_NOT_FOUND", "Context is absent or expired; initialize it with LOAD");
  return stored.context;
}
