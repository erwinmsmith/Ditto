import { randomUUID } from "node:crypto";
import type { NodeType } from "../node/index.js";
import type { ExecutionGraph } from "./graph.js";
import type { ExecutionScope } from "./transport.js";

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
