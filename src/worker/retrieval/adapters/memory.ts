import type {} from "../contracts.js";
import type { NodeResult } from "../../../contracts/node-result.js";
import type { RuntimeClient } from "../../execution-context.js";
import type { MemorySearchProvider } from "../../memory/providers/store.js";
import type { MemorySearchInput, MemorySearchOutput } from "../../memory/contracts.js";
import type { RetrievalSearchInput, RetrievalSearchOutput } from "../search/types.js";
import { RetrievalError, type RetrievalTarget } from "../types.js";
import { normalizeOutput, validateTarget } from "../search/schema.js";

export interface RemoteRetrievalSearchOptions {
  readonly runtime: Pick<RuntimeClient, "invoke">;
  readonly target: RetrievalTarget;
  /** Explicit domain mapping; may hydrate candidate IDs in one batch if needed. */
  readonly mapOutput: (output: RetrievalSearchOutput) => MemorySearchOutput | Promise<MemorySearchOutput>;
}

/** Opt-in adapter: MEMORY never imports or constructs this implementation. */
export class RemoteRetrievalSearchProvider implements MemorySearchProvider {
  readonly #options: RemoteRetrievalSearchOptions;
  constructor(options: RemoteRetrievalSearchOptions) {
    validateTarget(options.target);
    this.#options = { ...options, target: { ...options.target } };
  }
  async search(input: MemorySearchInput): Promise<MemorySearchOutput> {
    const request: RetrievalSearchInput = {
      query: { content: input.query }, target: { ...this.#options.target },
      ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
      ...(input.filter === undefined ? {} : { filter: input.filter }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.options === undefined ? {} : { options: input.options }),
    };
    let result: NodeResult<RetrievalSearchOutput>;
    try { result = await this.#options.runtime.invoke("RETRIEVAL.SEARCH", request); }
    catch { throw new RetrievalError("RETRIEVAL_BACKEND_ERROR", "Remote retrieval invocation failed"); }
    if (!result || result.status !== "success" || !result.output) {
      // A remote deployment may run untrusted adapters; do not echo its error message.
      throw new RetrievalError("RETRIEVAL_BACKEND_ERROR", "Remote retrieval operation failed");
    }
    return this.#options.mapOutput(normalizeOutput(result.output, request));
  }
}
