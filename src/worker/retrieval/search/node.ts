import type { RetrievalExecutionContext } from "./providers/types.js";
import type {} from "../contracts.js";
import { createNodeScaffold } from "../../node-scaffold.js";
import type { RetrievalResources } from "../registry/providers.js";
import { RetrievalError } from "../types.js";
import type { RetrievalSearchInput, RetrievalSearchOutput } from "./types.js";
import { normalizeOutput, validateSearch } from "./schema.js";

export async function searchNode(input: RetrievalSearchInput, resources: RetrievalResources, context: RetrievalExecutionContext = {}): Promise<RetrievalSearchOutput> {
  validateSearch(input);
  if (input.strategy?.trim().toLowerCase() === "rag") throw new RetrievalError("RETRIEVAL_STRATEGY_UNSUPPORTED", "RAG is a Graph, not a search strategy");
  context.signal?.throwIfAborted();
  const provider = resources.providers.resolve(input.target, input.strategy);
  if (!provider || typeof provider.search !== "function") throw new RetrievalError("RETRIEVAL_PROVIDER_UNAVAILABLE", "Search provider is unavailable");
  return normalizeOutput(await provider.search(input, context), input);
}
export const retrievalSearchNode = createNodeScaffold("RETRIEVAL.SEARCH");
