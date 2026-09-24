import { RetrievalError } from "../../types.js";
import type { RetrievalSearchProvider } from "../../registry/providers.js";
import type { EmbeddingProvider } from "./types.js";
import { embedContents, validateVector } from "./embedding.js";
import { normalizeOutput } from "../schema.js";

export interface VectorProviderOptions {
  readonly backend: RetrievalSearchProvider;
  readonly embedding?: EmbeddingProvider;
  /** Backend can embed raw queries itself (e.g. a configured database embedding function). */
  readonly nativeEmbedding?: boolean;
  readonly dimensions?: number;
}
export function createVectorSearchProvider(options: VectorProviderOptions): RetrievalSearchProvider {
  if (options.embedding && options.nativeEmbedding) throw new RetrievalError("RETRIEVAL_INVALID_INPUT", "Choose external or backend-native embedding");
  return { async search(input, context = {}) {
    context.signal?.throwIfAborted();
    let content = input.query.content;
    if (Array.isArray(content) && content.every(value => typeof value === "number")) {
      validateVector(content, options.dimensions ?? context.defaults?.embedding?.dimensions);
    } else if (options.embedding) {
      [content] = await embedContents(options.embedding, { contents: [content], purpose: "query" },
        options.dimensions === undefined ? {} : { dimensions: options.dimensions }, context);
    } else if (!options.nativeEmbedding) {
      throw new RetrievalError("RETRIEVAL_INVALID_INPUT", "Vector search requires a vector or an embedding provider");
    }
    const output = await options.backend.search({ ...input, query: { ...input.query, content } }, context);
    context.signal?.throwIfAborted();
    return normalizeOutput(output, input);
  } };
}
