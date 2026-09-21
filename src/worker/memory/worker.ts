import { randomUUID } from "node:crypto";
import { defineWorker, type WorkerDefinition } from "../define-worker.js";
import type { WorkerContext } from "../execution-context.js";
import type { NodeResult } from "../../contracts/node-result.js";
import type { MemoryResources } from "./providers/store.js";
import type { MemoryNode, MemoryInput, MemoryOutput } from "./contracts.js";
import type { MemoryDefaults } from "./types.js";
import { MemoryError, validateInput, validateOutput, integer } from "./validation.js";
import { getNode } from "./get/node.js";
import { queryNode } from "./query/node.js";
import { searchNode } from "./search/node.js";
import { writeNode } from "./write/node.js";
import { updateNode } from "./update/node.js";
import { deleteNode } from "./delete/node.js";

export interface MemoryOptions extends MemoryResources {
  readonly defaults?: MemoryDefaults;
  readonly concurrency?: number;
}
const handlers = {
  "MEMORY.GET": getNode, "MEMORY.QUERY": queryNode, "MEMORY.SEARCH": searchNode,
  "MEMORY.WRITE": writeNode, "MEMORY.UPDATE": updateNode, "MEMORY.DELETE": deleteNode,
};

/** Application-owned plugins; no implicit backend or workflow construction. */
export function createMemory(options: MemoryOptions) {
  const configuredDefaults = Object.freeze({ ...options.defaults });
  for (const [key, value] of Object.entries(configuredDefaults)) integer(value, key);
  const resources: MemoryResources = { store: options.store, ...(options.search === undefined ? {} : { search: options.search }) };

  async function execute<N extends MemoryNode>(
    node: N, input: MemoryInput<N>, defaults: MemoryDefaults = {},
  ): Promise<NodeResult<MemoryOutput<N>>> {
    const base = { executionId: randomUUID(), node };
    try {
      if (!Object.hasOwn(handlers, node)) throw new MemoryError("UNKNOWN_NODE", "Unknown MEMORY node");
      const op = node.slice(7).toLowerCase();
      if (node === "MEMORY.QUERY" || node === "MEMORY.SEARCH") {
        // Validate before defaulting so explicit invalid values never become defaults.
        validateInput(op, input);
        const limit = node === "MEMORY.QUERY"
          ? configuredDefaults.queryLimit ?? defaults.queryLimit ?? 100
          : configuredDefaults.searchLimit ?? defaults.searchLimit ?? 10;
        input = { ...input, limit: (input as { limit?: number }).limit ?? limit };
      }
      // Type erasure is confined to the heterogeneous handler dispatch.
      const handler = handlers[node] as (value: MemoryInput<N>, resources: MemoryResources) => Promise<MemoryOutput<N>>;
      const output = await handler(input, resources);
      validateOutput(op, output, input);
      return { ...base, status: "success", output };
    } catch (error) {
      return { ...base, status: "failed", error: error instanceof MemoryError
        ? { code: error.code, message: error.message }
        : { code: "MEMORY_BACKEND_ERROR", message: "Memory backend operation failed" } };
    }
  }
  return {
    execute,
    get: (input: MemoryInput<"MEMORY.GET">) => execute("MEMORY.GET", input),
    query: (input: MemoryInput<"MEMORY.QUERY">) => execute("MEMORY.QUERY", input),
    search: (input: MemoryInput<"MEMORY.SEARCH">) => execute("MEMORY.SEARCH", input),
    write: (input: MemoryInput<"MEMORY.WRITE">) => execute("MEMORY.WRITE", input),
    update: (input: MemoryInput<"MEMORY.UPDATE">) => execute("MEMORY.UPDATE", input),
    delete: (input: MemoryInput<"MEMORY.DELETE">) => execute("MEMORY.DELETE", input),
  };
}

export function createMemoryWorker(options: MemoryOptions): WorkerDefinition {
  const memory = createMemory(options);
  return defineWorker({
    type: "MEMORY",
    resources: () => memory,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    nodes: Object.fromEntries(Object.keys(handlers).map(node => [node,
      (input: never, ctx: WorkerContext<typeof memory>) =>
        ctx.resources.execute(node as MemoryNode, input, ctx.services.config.memory),
    ])),
  });
}
