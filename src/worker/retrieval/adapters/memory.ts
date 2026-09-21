import type {} from "../contracts.js";
import type { RetrievalSearchProvider } from "../registry/providers.js";
import type { RetrievalDefaults } from "../types.js";
import type { MemoryItem } from "../../memory/types.js";
import type { NodeResult } from "../../../contracts/node-result.js";
import type { RuntimeClient } from "../../execution-context.js";
import type { MemorySearchProvider } from "../../memory/providers/store.js";
import type { MemorySearchInput, MemorySearchOutput } from "../../memory/contracts.js";
import type { RetrievalSearchInput, RetrievalSearchOutput } from "../search/types.js";
import { RetrievalError, type RetrievalTarget } from "../types.js";
import { normalizeOutput, validateTarget, validateSearch, validateDefaults } from "../search/schema.js";

export interface RemoteRetrievalSearchOptions {
  readonly runtime: Pick<RuntimeClient, "invoke">;
  readonly target: RetrievalTarget;
  /** Explicit domain mapping; may hydrate candidate IDs in one batch if needed. */
  readonly mapOutput?: (output: RetrievalSearchOutput) => MemorySearchOutput | Promise<MemorySearchOutput>;
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
    return (this.#options.mapOutput ?? mapMemoryCandidates)(normalizeOutput(result.output, request));
  }
}

/** Convention: candidate.content is a complete MemoryItem, not only its text. */
export function mapMemoryCandidates(output: RetrievalSearchOutput): MemorySearchOutput {
  return output.candidates.map(candidate => {
    const memory = candidate.content as MemoryItem;
    if (!memory || typeof memory !== "object" || Array.isArray(memory) || typeof memory.id !== "string" || !memory.id.trim()
      || !Object.hasOwn(memory, "content") || (candidate.id !== undefined && candidate.id !== memory.id)
      || (memory.key !== undefined && (typeof memory.key !== "string" || !memory.key.length))
      || (memory.metadata !== undefined && (!memory.metadata || typeof memory.metadata !== "object" || Array.isArray(memory.metadata)))) {
      throw new RetrievalError("RETRIEVAL_INVALID_BACKEND_OUTPUT", "Memory candidates must contain complete MemoryItems");
    }
    return { memory, ...(candidate.score === undefined ? {} : { score: candidate.score }),
      metadata: { ...candidate.metadata, ...(candidate.source === undefined ? {} : { source: candidate.source }) } };
  });
}

/** Reuse a database's existing native search plugin inside the optional Worker. */
export function createMemoryRetrievalProvider(
  search: MemorySearchProvider,
  mapInput?: (input: RetrievalSearchInput) => MemorySearchInput,
): RetrievalSearchProvider {
  return { async search(input, context = {}) {
    context.signal?.throwIfAborted();
    if (!mapInput && input.target.namespace !== undefined) {
      throw new RetrievalError("RETRIEVAL_INVALID_INPUT", "Memory namespace requires an explicit input mapper");
    }
    const request = mapInput ? mapInput(input) : {
      query: input.query.content,
      ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
      ...(input.filter === undefined ? {} : { filter: input.filter }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.options === undefined ? {} : { options: input.options }),
    };
    const output = await search.search(request);
    context.signal?.throwIfAborted();
    const result = normalizeOutput({ target: input.target, strategy: input.strategy, candidates: output.map(hit => ({
      id: hit.memory.id, content: hit.memory, source: { target: input.target.name, ref: hit.memory.id },
      ...(hit.score === undefined ? {} : { score: hit.score }), ...(hit.metadata === undefined ? {} : { metadata: hit.metadata }),
    })) }, input);
    mapMemoryCandidates(result);
    return result;
  } };
}

/** Use the same embedding/search pipeline in MEMORY without registering another Worker. */
export function createRetrievalMemorySearchProvider(options: {
  readonly provider: RetrievalSearchProvider;
  readonly target: RetrievalTarget;
  readonly defaults?: RetrievalDefaults;
  readonly strategy?: string;
  readonly mapOutput?: RemoteRetrievalSearchOptions["mapOutput"];
}): MemorySearchProvider {
  validateTarget(options.target);
  const target = structuredClone(options.target);
  const defaults = structuredClone(options.defaults ?? {});
  validateDefaults(defaults);
  return { async search(input) {
    const strategy = input.strategy ?? options.strategy;
    const request: RetrievalSearchInput = { query: { content: input.query }, target: { ...target },
      limit: input.limit ?? defaults.searchLimit ?? 10,
      ...(strategy === undefined ? {} : { strategy }),
      ...(input.filter === undefined ? {} : { filter: input.filter }),
      ...(input.options === undefined ? {} : { options: input.options }),
    };
    validateSearch(request);
    return (options.mapOutput ?? mapMemoryCandidates)(normalizeOutput(await options.provider.search(request, { defaults }), request));
  } };
}
