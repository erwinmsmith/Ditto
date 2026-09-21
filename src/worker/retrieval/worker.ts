import { randomUUID } from "node:crypto";
import type { NodeResult } from "../../contracts/node-result.js";
import { defineWorker, type WorkerDefinition } from "../define-worker.js";
import type { RetrievalResources } from "./registry/providers.js";
import { RetrievalError, type RetrievalDefaults } from "./types.js";
import type { RetrievalSearchInput, RetrievalSearchOutput } from "./search/types.js";
import { searchNode } from "./search/node.js";
import { validateLimit, validateSearch } from "./search/schema.js";

export interface RetrievalOptions extends RetrievalResources {
  readonly defaults?: RetrievalDefaults;
  readonly concurrency?: number;
}
/** Stateless execution wrapper. Providers own connections, algorithm choices and backend deadlines. */
export function createRetrieval(options: RetrievalOptions) {
  const defaults = Object.freeze({ ...options.defaults });
  if (defaults.searchLimit !== undefined) validateLimit(defaults.searchLimit);
  const resources = { providers: options.providers };
  if (!resources.providers || typeof resources.providers.resolve !== "function") {
    throw new RetrievalError("RETRIEVAL_PROVIDER_UNAVAILABLE", "A provider registry is required");
  }
  async function search(input: RetrievalSearchInput, runtimeDefaults: RetrievalDefaults = {}): Promise<NodeResult<RetrievalSearchOutput>> {
    const base = { executionId: randomUUID(), node: "RETRIEVAL.SEARCH" };
    try {
      validateSearch(input);
      const request = { ...input, limit: input.limit ?? defaults.searchLimit ?? runtimeDefaults.searchLimit ?? 10 };
      const output = await searchNode(request, resources);
      return { ...base, status: "success", output };
    } catch (error) {
      const failure = error instanceof RetrievalError ? { code: error.code, message: error.message }
        : { code: "RETRIEVAL_BACKEND_ERROR", message: "Retrieval backend operation failed" };
      return { ...base, status: failure.code === "RETRIEVAL_TIMEOUT" ? "timeout" : "failed", error: failure };
    }
  }
  return { search };
}

export function createRetrievalWorker(options: RetrievalOptions): WorkerDefinition {
  const retrieval = createRetrieval(options);
  return defineWorker({
    type: "RETRIEVAL", resources: () => retrieval,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    nodes: { "RETRIEVAL.SEARCH": (input, ctx) => ctx.resources.search(input, ctx.services.config.retrieval) },
  });
}
