import type {
  NodeDefinition, NodeHandler, NodeType, NodesOfWorker, WorkerContext, WorkerType,
} from "../node/index.js";
import { workerTypeOf } from "../node/index.js";

export type WorkerNodes<W extends WorkerType, R, C> = {
  readonly [N in NodesOfWorker<W>]?: NodeHandler<N, R, C> | NodeDefinition<N, R, C>;
};

export type WorkerOptions<W extends WorkerType, R = undefined, C = undefined> = {
  readonly type: W;
  /** Called once per local registration, so replicas need not share resources. */
  readonly resources?: () => R;
  readonly config?: C;
  readonly nodes: WorkerNodes<NoInfer<W>, R, C>;
} & ([R] extends [undefined] ? unknown : { readonly resources: () => R })
  & ([C] extends [undefined] ? unknown : { readonly config: C });

/** Internal host dispatch boundary. Public callers use typed Runtime.invoke. */
export interface WorkerExecutor {
  execute(node: NodeType, input: unknown, services: WorkerContext): Promise<unknown>;
}

export interface WorkerDefinition {
  readonly type: WorkerType;
  readonly capabilities: readonly NodeType[];
  instantiate(): WorkerExecutor;
}

export function defineWorker<W extends WorkerType, R = undefined, C = undefined>(
  options: WorkerOptions<W, R, C>,
): WorkerDefinition {
  // Type erasure is limited to this heterogeneous lookup. Definitions are
  // checked per key by WorkerNodes, and dispatch checks capability membership.
  const handlers = new Map<NodeType, (input: unknown, ctx: WorkerContext<R, C>) => Promise<unknown>>();
  for (const [key, entry] of Object.entries(options.nodes)) {
    const node = key as NodeType;
    if (workerTypeOf(node) !== options.type) {
      throw new Error(`Worker ${options.type} cannot declare ${node}`);
    }
    const definition = entry as NodeHandler<NodeType, R, C> | NodeDefinition<NodeType, R, C>;
    if (typeof definition !== "function" && definition?.type !== node) {
      throw new Error(`Node definition does not match ${node}`);
    }
    const handler = typeof definition === "function" ? definition : definition.execute;
    if (typeof handler !== "function") throw new Error(`Missing handler for ${node}`);
    handlers.set(node, handler as (input: unknown, ctx: WorkerContext<R, C>) => Promise<unknown>);
  }
  if (handlers.size === 0) throw new Error("A Worker must implement at least one Node");
  const resourceFactory = options.resources;
  const config = options.config as C;
  return Object.freeze({
    type: options.type,
    capabilities: Object.freeze([...handlers.keys()]),
    instantiate(): WorkerExecutor {
      const resources = resourceFactory?.() as R;
      return {
        async execute(node, input, services) {
          const handler = handlers.get(node);
          if (!handler) throw new Error(`Worker does not implement ${node}`);
          return handler(input, { ...services, resources, config });
        },
      };
    },
  });
}
