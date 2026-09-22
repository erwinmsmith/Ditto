import type { RuntimeClient } from "../execution-context.js";
import type {
  Context, ContextItem, MessageContent, Reference,
} from "../../contracts/common.js";
import type { ContextCompressInput } from "./compress/types.js";
import type { ContextSelectInput } from "./select/types.js";

export interface ContextCallOptions {
  readonly signal?: AbortSignal;
  /** Worker-supplied invocation scope for optional delegation. */
  readonly runtime?: Pick<RuntimeClient, "invoke">;
}

export interface ContextPolicy {
  readonly maxInlineBytes: number;
  readonly maxItems: number;
  readonly maxTokens?: number;
  readonly duplicate: "replace" | "keep-first" | "reject";
  readonly missingRemoval: "ignore" | "reject";
}

export interface TokenEstimator {
  estimate(content: MessageContent, options?: ContextCallOptions): number | Promise<number>;
}

export interface ReferenceResolver {
  resolve(reference: Reference, options?: ContextCallOptions): Promise<MessageContent>;
}

export interface ContextSelector {
  select(input: ContextSelectInput, options?: ContextCallOptions): Promise<readonly ContextItem[]>;
}

export interface ContextRagStrategy extends ContextSelector {}

export interface ContextCompressor {
  compress(input: ContextCompressInput, options?: ContextCallOptions): Promise<Context>;
}

export interface ContextScope {
  readonly invocationId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
}

export interface StoredContext {
  readonly version: string;
  readonly context: Context;
}

export interface ContextStateStore {
  get(scope: ContextScope, options?: ContextCallOptions): Promise<StoredContext | undefined>;
  compareAndSet(
    scope: ContextScope,
    expectedVersion: string | undefined,
    next: Context,
    options?: ContextCallOptions,
  ): Promise<StoredContext>;
}

export interface ContextOperationQueue {
  enqueue<T>(scope: ContextScope, operation: () => Promise<T>, options?: ContextCallOptions): Promise<T>;
}

/** Worker resources. None of these interfaces is part of a Node payload. */
export interface ContextServices {
  readonly tokenEstimator?: TokenEstimator;
  readonly referenceResolver?: ReferenceResolver;
  readonly selector?: ContextSelector;
  readonly compressor?: ContextCompressor;
  readonly ragStrategy?: ContextRagStrategy;
  readonly stateStore?: ContextStateStore;
  readonly operationQueue?: ContextOperationQueue;
}

export interface ContextExecution extends ContextCallOptions {
  readonly policy: ContextPolicy;
  readonly services: ContextServices;
}
