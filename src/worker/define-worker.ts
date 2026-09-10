import type {
  NodeDefinition, NodeHandler, NodeType, WorkerContext, WorkerType,
} from "./node.js";
import { defineNode } from "./node.js";

export type WorkerNodes<R = undefined, C = undefined> = {
  readonly [N in NodeType]?: NodeHandler<N, R, C> | NodeDefinition<N, R, C>;
};

/** Short operation names for a single semantic namespace, including augmentation. */
type OperationOf<N extends string, T extends string> = N extends `${T}.${infer Op}` ? Op : never;
export type ScopedWorkerNodes<T extends string, R = undefined, C = undefined> = {
  readonly [Op in OperationOf<NodeType, T>]?:
    NodeHandler<Extract<NodeType, `${T}.${Op}`>, R, C> | NodeDefinition<Extract<NodeType, `${T}.${Op}`>, R, C>;
};

export type ScopedWorkerOptions<T extends string, R = undefined, C = undefined> =
  Omit<WorkerOptions<R, C>, "type" | "nodes"> & { readonly nodes: ScopedWorkerNodes<T, R, C> };

/** Add operations in a namespace; existing Worker definitions are not mutated. */
export function extendWorker<const T extends string, R = undefined, C = undefined>(
  type: T, options: ScopedWorkerOptions<T, R, C>,
): WorkerDefinition {
  const nodes: Record<string, unknown> = {};
  for (const [operation, handler] of Object.entries(options.nodes)) {
    if (!operation || operation.includes(".")) throw new Error("Expected a short Node operation name");
    nodes[`${type}.${operation}`] = handler;
  }
  // Requalifying keys preserves each operation's checked input/output contract.
  return defineWorker<R, C>({ ...options, type, nodes } as WorkerOptions<R, C>);
}

export type WorkerOptions<R = undefined, C = undefined> = {
  readonly type: WorkerType;
  /** Called once per local registration, so replicas need not share resources. */
  readonly resources?: () => R;
  readonly config?: C;
  /** Maximum concurrent top-level invocations per replica (default: unlimited). */
  readonly concurrency?: number;
  readonly dispose?: (resources: R) => void | Promise<void>;
  /** Public entry Nodes. Omit to expose all; internal Graphs can use every Node. */
  readonly expose?: readonly NodeType[];
  readonly nodes: WorkerNodes<R, C>;
} & ([R] extends [undefined] ? unknown : { readonly resources: () => R })
  & ([C] extends [undefined] ? unknown : { readonly config: C });

/** Internal host dispatch boundary. Public callers use typed Runtime.invoke. */
export interface WorkerExecutor {
  execute(node: NodeType, input: unknown, services: WorkerContext): Promise<unknown>;
  dispose?(): void | Promise<void>;
}

export interface WorkerDefinition {
  readonly type: WorkerType;
  readonly capabilities: readonly NodeType[];
  readonly nodeTypes?: readonly NodeType[];
  readonly concurrency?: number;
  instantiate(): WorkerExecutor;
}

export function defineWorker<R = undefined, C = undefined>(
  options: WorkerOptions<R, C>,
): WorkerDefinition {
  if (!options.type.trim()) throw new Error("Worker type cannot be empty");
  if (options.concurrency !== undefined && (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)) {
    throw new Error("Worker concurrency must be a positive integer");
  }
  // Type erasure is limited to this heterogeneous lookup. Definitions are
  // checked per key by WorkerNodes, and dispatch checks capability membership.
  const nodes = new Map<NodeType, NodeDefinition<NodeType, R, C>>();
  for (const [key, entry] of Object.entries(options.nodes)) {
    const node = key as NodeType;
    const definition = typeof entry === "function"
      ? defineNode(options.type, node, entry as NodeHandler<NodeType, R, C>)
      : entry as NodeDefinition<NodeType, R, C>;
    if (definition?.type !== node) {
      throw new Error(`Node definition does not match ${node}`);
    }
    if (definition.workerType !== options.type) {
      throw new Error(`Node ${node} belongs to Worker ${definition.workerType}, not ${options.type}`);
    }
    // Normalize structural definitions too: validate and snapshot before registration.
    nodes.set(node, typeof entry === "function" ? definition : defineNode(options.type, node, definition.execute));
  }
  if (nodes.size === 0) throw new Error("A Worker must implement at least one Node");
  const capabilities = [...new Set(options.expose ?? nodes.keys())];
  if (!capabilities.length || capabilities.some((node) => !nodes.has(node))) {
    throw new Error("Worker must expose at least one implemented Node");
  }
  const resourceFactory = options.resources;
  const config = options.config as C;
  return Object.freeze({
    type: options.type,
    capabilities: Object.freeze(capabilities),
    nodeTypes: Object.freeze([...nodes.keys()]),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    instantiate(): WorkerExecutor {
      const resources = resourceFactory?.() as R;
      return {
        dispose: () => options.dispose?.(resources),
        execute(node, input, services) {
          const definition = nodes.get(node);
          if (!definition) throw new Error(`Worker does not implement ${node}`);
          // Type erasure stays inside this heterogeneous dispatch table.
          const handler = definition.execute as (input: unknown, ctx: WorkerContext<R, C>) => Promise<unknown>;
          return handler(input, { ...services, resources, config });
        },
      };
    },
  });
}
