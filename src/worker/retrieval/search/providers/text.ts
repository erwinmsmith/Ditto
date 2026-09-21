import { RetrievalError } from "../../types.js";
import type { RetrievalSearchProvider } from "../../registry/providers.js";
import { normalizeOutput } from "../schema.js";

/** Full-text/BM25 execution stays in the configured database/search engine. */
export function createTextSearchProvider(backend: RetrievalSearchProvider): RetrievalSearchProvider {
  return { async search(input, context = {}) {
    if (typeof input.query.content !== "string" || !input.query.content.trim()) {
      throw new RetrievalError("RETRIEVAL_INVALID_INPUT", "Text search requires a nonempty query string");
    }
    context.signal?.throwIfAborted();
    const output = await backend.search(input, context);
    context.signal?.throwIfAborted();
    return normalizeOutput(output, input);
  } };
}
