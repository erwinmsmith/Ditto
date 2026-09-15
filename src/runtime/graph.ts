import { randomUUID } from "node:crypto";
import type { ExecutionScope } from "./communication/transport.js";
import type { InputOf, NodeType, OutputOf } from "../contracts/index.js";

export interface GraphTask {
  readonly id: string;
  readonly node: NodeType;
  readonly dependencies: readonly string[];
  readonly bind: (input: unknown, outputs: Readonly<Record<string, unknown>>) => unknown;
}

/** Immutable logical DAG. No Worker IDs, model configuration or host addresses. */
export class ExecutionGraph<I, O extends object = Record<never, never>> {
  private constructor(readonly id: string, readonly tasks: readonly GraphTask[]) {
    Object.freeze(this);
  }

  static create<I>(id: string): ExecutionGraph<I> {
    if (!id) throw new Error("Graph ID cannot be empty");
    return new ExecutionGraph<I>(id, Object.freeze([]));
  }

  node<const ID extends string, N extends NodeType, const D extends readonly (keyof O & string)[]>(
    id: ID,
    node: N,
    dependencies: D,
    bind: (input: I, outputs: Pick<O, D[number]>) => InputOf<NoInfer<N>>,
  ): ExecutionGraph<I, O & Record<ID, OutputOf<N>>> {
    if (!id || this.tasks.some((task) => task.id === id)) {
      throw new Error(`Duplicate or empty graph Node ID: ${id}`);
    }
    const known = new Set(this.tasks.map((task) => task.id));
    for (const dependency of dependencies) {
      if (!known.has(dependency)) throw new Error(`Unknown graph dependency: ${dependency}`);
    }
    const task: GraphTask = Object.freeze({
      id, node, dependencies: Object.freeze([...new Set(dependencies)]),
      // The builder checks the typed binder. Scheduler passes only declared outputs.
      bind: bind as GraphTask["bind"],
    });
    return new ExecutionGraph(this.id, Object.freeze([...this.tasks, task]));
  }
}

export function graph<I>(id = "agent"): ExecutionGraph<I> {
  return ExecutionGraph.create<I>(id);
}

export async function runGraph<I, O extends object>(
  graph: ExecutionGraph<I, O>,
  input: I,
  invoke: (node: NodeType, input: unknown, scope: ExecutionScope) => Promise<unknown>,
): Promise<O> {
  // Validate the whole plan before executing anything (also protects JS callers).
  const known = new Set<string>();
  for (const task of graph.tasks) {
    if (!task.id || known.has(task.id)) throw new Error(`Duplicate graph Node ID: ${task.id}`);
    for (const dependency of task.dependencies) {
      if (!known.has(dependency)) throw new Error(`Unknown or cyclic dependency: ${dependency}`);
    }
    known.add(task.id);
  }
  const runId = randomUUID();
  const outputs: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const jobs = new Map<string, Promise<void>>();
  for (const task of graph.tasks) {
    const job = Promise.all(task.dependencies.map((id) => jobs.get(id)!)).then(async () => {
      const dependencies = Object.fromEntries(task.dependencies.map((id) => [id, outputs[id]]));
      outputs[task.id] = await invoke(task.node, task.bind(input, Object.freeze(dependencies)), {
        graphId: graph.id, runId, nodeId: task.id,
      });
    });
    jobs.set(task.id, job);
  }
  // Drain already-started branches before rejecting. No hidden work after run settles.
  const settled = await Promise.allSettled(jobs.values());
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return Object.freeze(outputs) as O;
}
