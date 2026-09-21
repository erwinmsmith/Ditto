export interface RetrievalQuery { content: unknown; metadata?: Record<string, unknown>; }
export interface RetrievalTarget {
  name: string;
  type?: string;
  namespace?: string;
  metadata?: Record<string, unknown>;
}
export interface RetrievalCandidate {
  id?: string;
  content: unknown;
  score?: number;
  source?: { target?: string; ref?: string };
  metadata?: Record<string, unknown>;
}
export interface RetrievalDefaults {
  readonly searchLimit?: number;
  readonly embedding?: { readonly batchSize?: number; readonly dimensions?: number };
  readonly hybrid?: { readonly candidateLimit?: number; readonly rrfK?: number };
  readonly rerank?: { readonly candidateLimit?: number };
}

/** Messages on this explicit error are public; never include backend credentials. */
export class RetrievalError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RetrievalError";
  }
}
