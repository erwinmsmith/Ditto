import { RetrievalError } from "../../types.js";
import type { EmbeddingProvider, EmbeddingInput, RetrievalExecutionContext } from "./types.js";

export function validateVector(value: unknown, dimensions?: number): asserts value is readonly number[] {
  if (!Array.isArray(value) || !value.length
    || (dimensions !== undefined && value.length !== dimensions)) {
    throw new RetrievalError("RETRIEVAL_INVALID_EMBEDDING", "Embedding must contain finite numbers with consistent dimensions");
  }
  for (const component of value) {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new RetrievalError("RETRIEVAL_INVALID_EMBEDDING", "Embedding components must be finite numbers");
    }
  }
}

/** Used by query-time retrieval and explicit application-owned index preparation. */
export async function embedContents(
  provider: EmbeddingProvider, input: EmbeddingInput,
  options: { batchSize?: number; dimensions?: number } = {}, context: RetrievalExecutionContext = {},
): Promise<readonly (readonly number[])[]> {
  context.signal?.throwIfAborted();
  if (!Array.isArray(input.contents) || !["query", "document"].includes(input.purpose)) throw new RetrievalError("RETRIEVAL_INVALID_INPUT", "Invalid embedding input");
  const batchSize = options.batchSize ?? context.defaults?.embedding?.batchSize ?? 64;
  let dimensions = options.dimensions ?? context.defaults?.embedding?.dimensions;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 2048
    || (dimensions !== undefined && (!Number.isSafeInteger(dimensions) || dimensions < 1))) {
    throw new RetrievalError("RETRIEVAL_INVALID_INPUT", "Invalid embedding batch size or dimensions");
  }
  const vectors: (readonly number[])[] = [];
  for (let offset = 0; offset < input.contents.length; offset += batchSize) {
    context.signal?.throwIfAborted();
    const contents = input.contents.slice(offset, offset + batchSize);
    const batch = await provider.embed({ contents, purpose: input.purpose }, context);
    context.signal?.throwIfAborted();
    if (!Array.isArray(batch) || batch.length !== contents.length) throw new RetrievalError("RETRIEVAL_INVALID_EMBEDDING", "Embedding count does not match input count");
    for (const vector of batch) {
      validateVector(vector, dimensions);
      dimensions ??= vector.length;
      vectors.push(vector);
    }
  }
  return vectors;
}
