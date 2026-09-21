import { defineWorker, type WorkerDefinition } from "../define-worker.js";
import type { WorkerContext } from "../execution-context.js";
import type {
  ContextInput, ContextNode, ContextOutput,
} from "./contracts.js";
import type { ContextPolicy, ContextServices } from "./types.js";
import { createContextExecution } from "./execution.js";
import { loadNode } from "./load/node.js";
import { selectNode } from "./select/node.js";
import { updateNode } from "./update/node.js";
import { compressNode } from "./compress/node.js";

export interface ContextOptions {
  readonly policy?: Partial<ContextPolicy>;
  readonly services?: ContextServices;
}

export interface ContextClient {
  execute<N extends ContextNode>(node: N, input: ContextInput<N>): Promise<ContextOutput<N>>;
  load(input: ContextInput<"CONTEXT.LOAD">): Promise<ContextOutput<"CONTEXT.LOAD">>;
  select(input: ContextInput<"CONTEXT.SELECT">): Promise<ContextOutput<"CONTEXT.SELECT">>;
  update(input: ContextInput<"CONTEXT.UPDATE">): Promise<ContextOutput<"CONTEXT.UPDATE">>;
  compress(input: ContextInput<"CONTEXT.COMPRESS">): Promise<ContextOutput<"CONTEXT.COMPRESS">>;
}

const handlers = {
  "CONTEXT.LOAD": loadNode,
  "CONTEXT.SELECT": selectNode,
  "CONTEXT.UPDATE": updateNode,
  "CONTEXT.COMPRESS": compressNode,
};

/** The direct SDK and Runtime Worker share the same validated leaf handlers. */
export function createContext(options: ContextOptions = {}): ContextClient {
  const execution = createContextExecution(options.policy, options.services);
  async function execute<N extends ContextNode>(node: N, input: ContextInput<N>): Promise<ContextOutput<N>> {
    const handler = handlers[node] as (
      value: ContextInput<N>,
      context: typeof execution,
    ) => Promise<ContextOutput<N>>;
    return handler(input, execution);
  }
  return Object.freeze({
    execute,
    load: (input: ContextInput<"CONTEXT.LOAD">) => execute("CONTEXT.LOAD", input),
    select: (input: ContextInput<"CONTEXT.SELECT">) => execute("CONTEXT.SELECT", input),
    update: (input: ContextInput<"CONTEXT.UPDATE">) => execute("CONTEXT.UPDATE", input),
    compress: (input: ContextInput<"CONTEXT.COMPRESS">) => execute("CONTEXT.COMPRESS", input),
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
    }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    nodes: {
      "CONTEXT.LOAD": (input: ContextInput<"CONTEXT.LOAD">, ctx: WorkerContext<ContextClient>) => ctx.resources.load(input),
      "CONTEXT.SELECT": (input: ContextInput<"CONTEXT.SELECT">, ctx: WorkerContext<ContextClient>) => ctx.resources.select(input),
      "CONTEXT.UPDATE": (input: ContextInput<"CONTEXT.UPDATE">, ctx: WorkerContext<ContextClient>) => ctx.resources.update(input),
      "CONTEXT.COMPRESS": (input: ContextInput<"CONTEXT.COMPRESS">, ctx: WorkerContext<ContextClient>) => ctx.resources.compress(input),
    },
  });
}
