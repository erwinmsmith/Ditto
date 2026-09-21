import { RetrievalError } from "../../types.js";
import type { RetrievalSearchProvider } from "../../registry/providers.js";
import type { RetrievalSearchOutput } from "../types.js";
import type { EmbeddingProvider, RerankProvider, RerankInput, RetrievalExecutionContext } from "./types.js";
import { embedContents } from "./embedding.js";
import { normalizeOutput, validateLimit } from "../schema.js";

export async function rerankCandidates(provider: RerankProvider, input: RerankInput, context: RetrievalExecutionContext = {}) {
  validateLimit(input.limit);
  context.signal?.throwIfAborted();
  if (!input.candidates.length) return [];
  const order = await provider.rank(input, context);
  context.signal?.throwIfAborted();
  if (!Array.isArray(order) || order.length !== Math.min(input.limit, input.candidates.length)) {
    throw new RetrievalError("RETRIEVAL_INVALID_BACKEND_OUTPUT", "Reranker returned an invalid result count");
  }
  const seen = new Set<number>();
  return Array.from(order, entry => {
    if (!entry || !Number.isSafeInteger(entry.index) || entry.index < 0 || entry.index >= input.candidates.length
      || seen.has(entry.index) || (entry.score !== undefined && !Number.isFinite(entry.score))) {
      throw new RetrievalError("RETRIEVAL_INVALID_BACKEND_OUTPUT", "Reranker returned an invalid candidate index or score");
    }
    seen.add(entry.index);
    const candidate = input.candidates[entry.index]!;
    return entry.score === undefined ? candidate : { ...candidate, score: entry.score };
  });
}

export function createRerankSearchProvider(options: {
  readonly search: RetrievalSearchProvider; readonly reranker: RerankProvider; readonly candidateLimit?: number;
}): RetrievalSearchProvider {
  return { async search(input, context = {}) {
    const limit = input.limit ?? context.defaults?.searchLimit ?? 10;
    const pool = options.candidateLimit ?? context.defaults?.rerank?.candidateLimit ?? 100;
    validateLimit(pool);
    const candidateLimit = Math.max(limit, pool);
    validateLimit(limit);
    validateLimit(candidateLimit);
    context.signal?.throwIfAborted();
    const request = { ...input, limit: candidateLimit };
    const output = normalizeOutput(await options.search.search(request, context), request);
    const candidates = await rerankCandidates(options.reranker, { query: input.query, candidates: output.candidates, limit }, context);
    return { ...output, candidates } satisfies RetrievalSearchOutput;
  } };
}

/** Local numerical reranking with a replaceable embedding model; no generated text is used as scores. */
export function createCosineReranker(embedding: EmbeddingProvider): RerankProvider {
  return { async rank(input, context = {}) {
    const [query] = await embedContents(embedding, { contents: [input.query.content], purpose: "query" }, {}, context);
    const documents = await embedContents(embedding, { contents: input.candidates.map(c => c.content), purpose: "document" }, { dimensions: query!.length }, context);
    const unit = (vector: readonly number[]) => {
      const scale = vector.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
      if (!scale) return vector;
      const norm = vector.reduce((norm, value) => Math.hypot(norm, value / scale), 0);
      return vector.map(value => (value / scale) / norm);
    };
    const normalizedQuery = unit(query!);
    return documents.map((vector, index) => {
      const score = unit(vector).reduce((sum, v, i) => sum + v * normalizedQuery[i]!, 0);
      return { index, score };
    }).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, input.limit);
  } };
}
