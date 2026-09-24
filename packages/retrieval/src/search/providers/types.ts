import type { RetrievalCandidate, RetrievalQuery, RetrievalDefaults } from "../../types.js";
export interface RetrievalExecutionContext {
  readonly signal?: AbortSignal;
  readonly defaults?: RetrievalDefaults;
}
export interface EmbeddingInput {
  readonly contents: readonly unknown[];
  readonly purpose: "query" | "document";
}
export interface EmbeddingProvider {
  embed(input: EmbeddingInput, context?: RetrievalExecutionContext): Promise<readonly (readonly number[])[]>;
}
export interface RerankInput {
  readonly query: RetrievalQuery;
  readonly candidates: readonly RetrievalCandidate[];
  readonly limit: number;
}
/** Indexes identify the original candidates; a reranker cannot fabricate content. */
export interface RerankResult { readonly index: number; readonly score?: number; }
export interface RerankProvider {
  rank(input: RerankInput, context?: RetrievalExecutionContext): Promise<readonly RerankResult[]>;
}
