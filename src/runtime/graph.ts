import type { InputOf, OutputOf } from "../contracts/index.js";
import type { NodeType } from "../node/index.js";

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
