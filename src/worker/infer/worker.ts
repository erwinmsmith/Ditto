import { validateRuntimeSettings, type InferSettings } from "../../runtime/settings.js";
import { randomUUID } from "node:crypto";
import type { WorkerContext } from "../execution-context.js";
import { defineWorker, type WorkerDefinition } from "../define-worker.js";
import type { InferCallOptions, InferStreamEvent, NodeResult } from "./types.js";
import type { InferNode, InferInput, InferOutput } from "./contracts.js";
import type { InferExecution } from "./execution.js";
import type { ModelProvider } from "./providers/types.js";
import { ProviderRegistry } from "./providers/registry.js";
import type { RuntimeServices } from "../../runtime/services.js";
import { InMemoryInferCache, type InferCacheProvider } from "./cache/provider.js";
import type { TrajectoryStrategy } from "./reasoning/trajectory/strategies/index.js";
import { sampleNode } from "./reasoning/sample/node.js";
import { trajectoryNode, TrajectoryFailure } from "./reasoning/trajectory/node.js";
import { reflectNode } from "./reasoning/reflect/node.js";
import { deliberateNode } from "./reasoning/deliberate/node.js";
import { lookupNode } from "./cache/lookup/node.js";
import { writeNode } from "./cache/write/node.js";
import { invalidateNode } from "./cache/invalidate/node.js";
import { errorInfo, InferError, number } from "./validation.js";

export interface InferOptions {
  /** Explicit defaults replace Runtime infer defaults; snapshotted at creation. */
  defaults?: InferSettings;
  providers?: ProviderRegistry | Readonly<Record<string, ModelProvider>>;
  defaultProvider?: string;
  /** Omit for an isolated in-memory cache; supply a shared backend for multiple replicas. */
  cache?: InferCacheProvider;
  strategies?: Readonly<Record<string, TrajectoryStrategy>>;
  runtime?: { readonly services: RuntimeServices };
  /** Default per-call deadline, including provider work. Defaults to Runtime configuration, or 30 seconds without a Runtime. */
  timeoutMs?: number;
}
export interface InferMethod<N extends InferNode> {
  (input: InferInput<N>, options?: InferCallOptions): Promise<NodeResult<InferOutput<N>>>;
  stream(input: InferInput<N>, options?: InferCallOptions): AsyncIterable<InferStreamEvent<InferOutput<N>>>;
}
export interface InferClient {
  execute<N extends InferNode>(node: N, input: InferInput<N>, options?: InferCallOptions): Promise<NodeResult<InferOutput<N>>>;
  execute<I, O>(node: string, input: I, options?: InferCallOptions): Promise<NodeResult<O>>;
  reasoning: {
    sample: InferMethod<"INFER.REASONING.SAMPLE">;
    trajectory: InferMethod<"INFER.REASONING.TRAJECTORY">;
    reflect: InferMethod<"INFER.REASONING.REFLECT">;
    deliberate: InferMethod<"INFER.REASONING.DELIBERATE">;
  };
  cache: {
    lookup(input: InferInput<"INFER.CACHE.LOOKUP">, options?: InferCallOptions): Promise<NodeResult<InferOutput<"INFER.CACHE.LOOKUP">>>;
    write(input: InferInput<"INFER.CACHE.WRITE">, options?: InferCallOptions): Promise<NodeResult<InferOutput<"INFER.CACHE.WRITE">>>;
    invalidate(input: InferInput<"INFER.CACHE.INVALIDATE">, options?: InferCallOptions): Promise<NodeResult<InferOutput<"INFER.CACHE.INVALIDATE">>>;
  };
}
const handlers: { [N in InferNode]: (input: InferInput<N>, ctx: InferExecution) => Promise<InferOutput<N>> } = {
  "INFER.REASONING.SAMPLE": sampleNode,
  "INFER.REASONING.TRAJECTORY": trajectoryNode,
  "INFER.REASONING.REFLECT": reflectNode,
  "INFER.REASONING.DELIBERATE": deliberateNode,
  "INFER.CACHE.LOOKUP": lookupNode,
  "INFER.CACHE.WRITE": writeNode,
  "INFER.CACHE.INVALIDATE": invalidateNode,
};
/** One executor per SDK/replica; invocation context is always passed per call. */
function createExecutor(options: InferOptions) {
  const defaults = options.defaults === undefined ? undefined : validateRuntimeSettings({ workers: { infer: options.defaults } }).workers!.infer;
  const providers = options.providers instanceof ProviderRegistry ? options.providers : options.providers ? new ProviderRegistry(options.providers) : undefined;
  const fallbackProviders = new ProviderRegistry();
  const strategies = Object.freeze({ ...options.strategies });
  const cache = options.cache ?? new InMemoryInferCache();
  const timeoutMs = options.timeoutMs ?? options.runtime?.services.config.timeoutMs ?? 30_000; number(timeoutMs, "timeoutMs", 1, 2 ** 31 - 1, true);
  return async (node: string, input: unknown, call: InferCallOptions = {}, emit?: (event: InferStreamEvent<unknown>) => void, services = options.runtime?.services): Promise<NodeResult<unknown>> => {
    const executionId = randomUUID(); let timer: ReturnType<typeof setTimeout> | undefined;
    let signal: AbortSignal | undefined;
    const base = { executionId, node };
    try {
      emit?.({ type: "start", ...base });
      const inferDefaults = defaults ?? services?.config.infer;
      let deadline = call.timeoutMs ?? options.timeoutMs ?? services?.config.timeoutMs ?? timeoutMs; number(deadline, "timeoutMs", 1, 2 ** 31 - 1, true);
      if (node === "INFER.REASONING.TRAJECTORY") {
        const constraints = input && typeof input === "object" && "constraints" in input ? input.constraints : undefined;
        const requested = constraints && typeof constraints === "object" && "timeoutMs" in constraints ? constraints.timeoutMs : undefined;
        const limit = requested ?? inferDefaults?.constraints?.timeoutMs;
        if (limit !== undefined) { number(limit, "constraints.timeoutMs", 1, 2 ** 31 - 1, true); deadline = Math.min(deadline, limit); }
      }
      const controller = new AbortController(); timer = setTimeout(() => controller.abort(new DOMException("INFER deadline exceeded", "TimeoutError")), deadline);
      signal = call.signal ? AbortSignal.any([call.signal, controller.signal]) : controller.signal;
      signal.throwIfAborted();
      const defaultProvider = options.defaultProvider ?? services?.config.model?.provider;
      const ctx: InferExecution = {
        ...(inferDefaults ? { defaults: inferDefaults } : {}),
        signal, providers: providers ?? services?.providers ?? fallbackProviders, strategies, cache, streaming: Boolean(emit),
        ...(defaultProvider !== undefined ? { defaultProvider } : {}),
        emitDelta: delta => { if (!signal!.aborted) emit?.({ type: "text_delta", ...base, delta }); },
        emitStep: step => { if (!signal!.aborted) emit?.({ type: "step", ...base, step }); },
        sample: value => sampleNode(value, ctx),
      };
      if (!Object.hasOwn(handlers, node)) throw new InferError("UNKNOWN_NODE", `Unknown INFER node: ${node}`);
      const handler = handlers[node as InferNode] as (value: unknown, context: InferExecution) => Promise<unknown>;
      const output = await handler(input, ctx);
      return { ...base, status: "success", output };
    } catch (error) {
      const info = signal?.aborted ? { code: signal.reason instanceof Error && signal.reason.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED", message: signal.reason instanceof Error ? signal.reason.message : "Execution cancelled" } : errorInfo(error);
      return { ...base, status: info.code === "TIMEOUT" ? "timeout" : info.code === "CANCELLED" ? "cancelled" : "failed", error: info,
        ...(error instanceof TrajectoryFailure ? { output: error.output } : {}) };
    } finally { clearTimeout(timer); }
  };
}
/** Same leaf handlers power direct SDK calls, local Runtime dispatch, and remote Runtime dispatch. */
export function createInfer(options: InferOptions = {}): InferClient {
  const execute = createExecutor(options);
  async function* stream<N extends InferNode>(node: N, input: InferInput<N>, call: InferCallOptions = {}): AsyncIterable<InferStreamEvent<InferOutput<N>>> {
    const controller = new AbortController(); const signal = call.signal ? AbortSignal.any([call.signal, controller.signal]) : controller.signal;
    let queue: InferStreamEvent<unknown>[] = []; let wake: (() => void) | undefined; let done = false;
    const emit = (event: InferStreamEvent<unknown>) => { if (!controller.signal.aborted) queue.push(event); wake?.(); };
    const job = execute(node, input, { ...call, signal }, emit).then(result => {
      emit({ type: "result", executionId: result.executionId, node, result }); done = true; wake?.();
    });
    try {
      while (!done || queue.length) {
        if (!queue.length) await new Promise<void>(resolve => { wake = resolve; });
        const batch = queue; queue = [];
        yield* batch as InferStreamEvent<InferOutput<N>>[];
      }
    } finally { controller.abort(new DOMException("Stream consumer closed", "AbortError")); await job; }
  }
  const method = <N extends InferNode>(node: N): InferMethod<N> => Object.assign(
    (input: InferInput<N>, call?: InferCallOptions) => execute(node, input, call) as Promise<NodeResult<InferOutput<N>>>,
    { stream: (input: InferInput<N>, call?: InferCallOptions) => stream(node, input, call) },
  );
  return {
    execute: execute as InferClient["execute"],
    reasoning: { sample: method("INFER.REASONING.SAMPLE"), trajectory: method("INFER.REASONING.TRAJECTORY"), reflect: method("INFER.REASONING.REFLECT"), deliberate: method("INFER.REASONING.DELIBERATE") },
    cache: {
      lookup: (input, call) => execute("INFER.CACHE.LOOKUP", input, call) as Promise<NodeResult<InferOutput<"INFER.CACHE.LOOKUP">>>,
      write: (input, call) => execute("INFER.CACHE.WRITE", input, call) as Promise<NodeResult<InferOutput<"INFER.CACHE.WRITE">>>,
      invalidate: (input, call) => execute("INFER.CACHE.INVALIDATE", input, call) as Promise<NodeResult<InferOutput<"INFER.CACHE.INVALIDATE">>>,
    },
  };
}
export interface InferWorkerOptions extends Omit<InferOptions, "runtime" | "cache"> {
  cache?: InferCacheProvider;
  cacheFactory?: () => InferCacheProvider;
  concurrency?: number;
}
export function createInferWorker(options: InferWorkerOptions = {}): WorkerDefinition {
  number(options.timeoutMs ?? 30_000, "timeoutMs", 1, 2 ** 31 - 1, true);
  if (options.defaults) options = { ...options, defaults: validateRuntimeSettings({ workers: { infer: options.defaults } }).workers!.infer! };
  options = { ...options, strategies: Object.freeze({ ...options.strategies }) };
  // Internal SAMPLE calls share the executor and consume no extra routing slot.
  return defineWorker({ type: "INFER",
    resources: () => createExecutor({ ...options, cache: options.cacheFactory?.() ?? options.cache ?? new InMemoryInferCache() }),
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    nodes: Object.fromEntries(Object.keys(handlers).map(node => [node,
      (input: unknown, ctx: WorkerContext<ReturnType<typeof createExecutor>>) =>
        ctx.resources(node, input, ctx.signal ? { signal: ctx.signal } : {}, undefined, ctx.services),
    ])),
  });
}
