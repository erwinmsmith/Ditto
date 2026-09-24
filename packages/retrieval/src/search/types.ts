import type { RetrievalQuery, RetrievalTarget, RetrievalCandidate } from "../types.js";
export interface RetrievalSearchInput {
  query: RetrievalQuery;
  target: RetrievalTarget;
  strategy?: string;
  filter?: Record<string, unknown>;
  limit?: number;
  options?: Record<string, unknown>;
}
export interface RetrievalSearchOutput {
  candidates: readonly RetrievalCandidate[];
  strategy?: string;
  target: RetrievalTarget;
  metadata?: Record<string, unknown>;
}
