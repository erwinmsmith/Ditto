import type { Context } from "../../contracts/common.js";
import { check, nonempty, object, ContextError } from "./validation.js";
import { contextScopeKey, readContextState, requireContextState } from "./state.js";
import type { ContextStateInput } from "./state.js";
import { createRedisContextStore, type RedisContextClient, type RedisContextOptions } from "./redis.js";
import { defineWorker, type WorkerDefinition } from "../define-worker.js";
import type { WorkerContext } from "../execution-context.js";
import type {
  ContextInput, ContextNode, ContextOutput,
} from "./contracts.js";
import type { ContextPolicy, ContextServices, ContextCallOptions } from "./types.js";
import { createContextExecution } from "./execution.js";
import { loadNode } from "./load/node.js";
import { selectNode } from "./select/node.js";
import { updateNode } from "./update/node.js";
import { compressNode } from "./compress/node.js";

export interface ContextOptions {
  readonly policy?: Partial<ContextPolicy>;
  /** Default cache adapter when a Redis SDK client is supplied. */
  readonly redis?: { readonly client: RedisContextClient } & RedisContextOptions;
  readonly services?: ContextServices;
}

export interface ContextClient {
  execute<N extends ContextNode>(node: N, input: ContextInput<N>, call?: ContextCallOptions): Promise<ContextOutput<N>>;
  load(input: ContextInput<"CONTEXT.LOAD">, call?: ContextCallOptions): Promise<ContextOutput<"CONTEXT.LOAD">>;
  select(input: ContextInput<"CONTEXT.SELECT">, call?: ContextCallOptions): Promise<ContextOutput<"CONTEXT.SELECT">>;
  update(input: ContextInput<"CONTEXT.UPDATE">, call?: ContextCallOptions): Promise<ContextOutput<"CONTEXT.UPDATE">>;
  compress(input: ContextInput<"CONTEXT.COMPRESS">, call?: ContextCallOptions): Promise<ContextOutput<"CONTEXT.COMPRESS">>;
}

const handlers = {
  "CONTEXT.LOAD": loadNode,
  "CONTEXT.SELECT": selectNode,
  "CONTEXT.UPDATE": updateNode,
  "CONTEXT.COMPRESS": compressNode,
};

/** The direct SDK and Runtime Worker share the same validated leaf handlers. */
export function createContext(options: ContextOptions = {}): ContextClient {
  check(!(options.redis && options.services?.stateStore), "Configure either redis or stateStore");
  const services = options.redis
    ? { ...options.services, stateStore: createRedisContextStore(options.redis.client, options.redis) }
    : options.services;
  const baseExecution = createContextExecution(options.policy, services);
  async function execute<N extends ContextNode>(node: N, input: ContextInput<N>, call?: ContextCallOptions): Promise<ContextOutput<N>> {
    const execution = { ...baseExecution, signal: call?.signal, runtime: call?.runtime };
    execution.signal?.throwIfAborted();
    check(Object.hasOwn(handlers, node), "Unknown Context node", "UNKNOWN_NODE");
    const request = object(input, "input");
    if (node === "CONTEXT.LOAD" && request.resolveReferences !== undefined) {
      check(typeof request.resolveReferences === "boolean", "resolveReferences must be a boolean");
      check(!request.resolveReferences || request.sources !== undefined, "resolveReferences requires sources");
    }
    const handler = handlers[node] as (value: unknown, context: typeof execution) => Promise<ContextOutput<N>>;
    if (request.scope === undefined) {
      check(request.expectedVersion === undefined, "expectedVersion requires scope");
      const output = await handler(input, execution);
      execution.signal?.throwIfAborted();
      return output;
    }
    const state = input as ContextStateInput;
    contextScopeKey(state.scope);
    const scope = Object.freeze({ ...state.scope });
    const expectedVersion = state.expectedVersion;
    check(request.context === undefined, "Pass either context or scope, not both");
    if (expectedVersion !== undefined) nonempty(expectedVersion, "expectedVersion");
    const store = execution.services.stateStore;
    if (!store) throw new ContextError("STATE_STORE_UNAVAILABLE", "Configure a Context state store or Redis client");
    const operation = async (): Promise<ContextOutput<N>> => {
      execution.signal?.throwIfAborted();
      const stored = await readContextState(store, scope, call);
      execution.signal?.throwIfAborted();
      if (expectedVersion !== undefined && stored?.version !== expectedVersion) {
        throw new ContextError("STATE_CONFLICT", "Context version changed or expired");
      }
      if (node === "CONTEXT.LOAD" && request.sources === undefined) {
        return requireContextState(stored) as ContextOutput<N>;
      }
      const resolved = node === "CONTEXT.LOAD" ? input : { ...request, context: requireContextState(stored) };
      const output = await handler(resolved, execution);
      execution.signal?.throwIfAborted();
      // SELECT is a projection; it never replaces the session's working set.
      if (node !== "CONTEXT.SELECT") await store.compareAndSet(scope, stored?.version, output as Context, call);
      execution.signal?.throwIfAborted();
      return output;
    };
    return execution.services.operationQueue?.enqueue(scope, operation, call) ?? operation();
  }
  return Object.freeze({
    execute,
    load: (input: ContextInput<"CONTEXT.LOAD">, call?: ContextCallOptions) => execute("CONTEXT.LOAD", input, call),
    select: (input: ContextInput<"CONTEXT.SELECT">, call?: ContextCallOptions) => execute("CONTEXT.SELECT", input, call),
    update: (input: ContextInput<"CONTEXT.UPDATE">, call?: ContextCallOptions) => execute("CONTEXT.UPDATE", input, call),
    compress: (input: ContextInput<"CONTEXT.COMPRESS">, call?: ContextCallOptions) => execute("CONTEXT.COMPRESS", input, call),
  });
}

export interface ContextWorkerOptions extends ContextOptions {
  /** Creates isolated resources for each local replica when supplied. */
  readonly servicesFactory?: () => ContextServices;
  readonly concurrency?: number;
}

export function createContextWorker(options: ContextWorkerOptions = {}): WorkerDefinition {
  return defineWorker({
    type: "CONTEXT",
    resources: () => createContext({
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      services: options.servicesFactory?.() ?? options.services ?? {},
      ...(options.redis === undefined ? {} : { redis: options.redis }),
    }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    nodes: {
      "CONTEXT.LOAD": (input: ContextInput<"CONTEXT.LOAD">, ctx: WorkerContext<ContextClient>) => ctx.resources.load(input, { runtime: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) }),
      "CONTEXT.SELECT": (input: ContextInput<"CONTEXT.SELECT">, ctx: WorkerContext<ContextClient>) => ctx.resources.select(input, { runtime: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) }),
      "CONTEXT.UPDATE": (input: ContextInput<"CONTEXT.UPDATE">, ctx: WorkerContext<ContextClient>) => ctx.resources.update(input, { runtime: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) }),
      "CONTEXT.COMPRESS": (input: ContextInput<"CONTEXT.COMPRESS">, ctx: WorkerContext<ContextClient>) => ctx.resources.compress(input, { runtime: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) }),
    },
  });
}
