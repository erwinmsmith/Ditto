import type { RetrievalExecutionContext } from "./search/providers/types.js";
import { randomUUID } from "node:crypto";
import type { NodeResult } from "@codesoul-co/ditto/contracts";
import { defineWorker, type WorkerDefinition } from "@codesoul-co/ditto/worker";
import type { RetrievalResources } from "./registry/providers.js";
import { RetrievalError, type RetrievalDefaults } from "./types.js";
import type { RetrievalSearchInput, RetrievalSearchOutput } from "./search/types.js";
import { searchNode } from "./search/node.js";
import { validateDefaults, validateSearch } from "./search/schema.js";

export interface RetrievalOptions extends RetrievalResources {
  readonly defaults?: RetrievalDefaults;
  readonly concurrency?: number;
}
/** Stateless execution wrapper. Providers own connections, algorithm choices and backend deadlines. */
export function createRetrieval(options: RetrievalOptions) {
  const defaults = Object.freeze(structuredClone(options.defaults ?? {}));
  validateDefaults(defaults);
  for (const group of [defaults.embedding, defaults.hybrid, defaults.rerank]) if (group) Object.freeze(group);
  const resources = { providers: options.providers };
  if (!resources.providers || typeof resources.providers.resolve !== "function") {
    throw new RetrievalError("RETRIEVAL_PROVIDER_UNAVAILABLE", "A provider registry is required");
  }
  async function search(input: RetrievalSearchInput, runtimeDefaults: RetrievalDefaults = {}, context: RetrievalExecutionContext = {}): Promise<NodeResult<RetrievalSearchOutput>> {
    const base = { executionId: randomUUID(), node: "RETRIEVAL.SEARCH" };
    try {
      validateSearch(input);
      validateDefaults(runtimeDefaults);
      const request = { ...input, limit: input.limit ?? defaults.searchLimit ?? runtimeDefaults.searchLimit ?? 10 };
      const effective = { ...runtimeDefaults, ...defaults,
        embedding: { ...runtimeDefaults.embedding, ...defaults.embedding },
        hybrid: { ...runtimeDefaults.hybrid, ...defaults.hybrid },
        rerank: { ...runtimeDefaults.rerank, ...defaults.rerank } };
      const output = await searchNode(request, resources, { ...context, defaults: effective });
      context.signal?.throwIfAborted();
      return { ...base, status: "success", output };
    } catch (error) {
      const failure = context.signal?.aborted ? { code: "RETRIEVAL_CANCELLED", message: "Retrieval cancelled" } : error instanceof RetrievalError ? { code: error.code, message: error.message }
        : { code: "RETRIEVAL_BACKEND_ERROR", message: "Retrieval backend operation failed" };
      return { ...base, status: failure.code === "RETRIEVAL_TIMEOUT" ? "timeout" : failure.code === "RETRIEVAL_CANCELLED" ? "cancelled" : "failed", error: failure };
    }
  }
  return { search };
}

export function createRetrievalWorker(options: RetrievalOptions): WorkerDefinition {
  const retrieval = createRetrieval(options);
  return defineWorker({
    type: "RETRIEVAL", resources: () => retrieval,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    nodes: { "RETRIEVAL.SEARCH": (input, ctx) => ctx.resources.search(input, ctx.services.config.retrieval, ctx.signal ? { signal: ctx.signal } : {}) },
  });
}
