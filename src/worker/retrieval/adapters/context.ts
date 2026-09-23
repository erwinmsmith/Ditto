import type {} from "../contracts.js";
import type { ContextItem } from "../../../contracts/common.js";
import type { RuntimeClient } from "../../execution-context.js";
import type { ContextCallOptions, ContextRagStrategy } from "../../context/types.js";
import type { ContextSelectInput } from "../../context/select/types.js";
import { snapshotItem, stableContextId } from "../../context/execution.js";
import { contextItem, messageContent, ContextError } from "../../context/validation.js";
import type { RetrievalSearchProvider } from "../registry/providers.js";
import type { RetrievalSearchInput, RetrievalSearchOutput } from "../search/types.js";
import { normalizeOutput, validateDefaults, validateSearch, validateTarget } from "../search/schema.js";
import { RetrievalError, type RetrievalDefaults, type RetrievalTarget } from "../types.js";

export type RetrievalContextOptions = {
  readonly target: RetrievalTarget;
  readonly strategy?: string;
  readonly defaults?: RetrievalDefaults;
  /** Required when corpus/filter/tenant semantics need application-specific translation. */
  readonly mapInput?: (input: ContextSelectInput) => RetrievalSearchInput;
  readonly mapOutput?: (output: RetrievalSearchOutput) => readonly ContextItem[] | Promise<readonly ContextItem[]>;
} & ({ readonly provider: RetrievalSearchProvider; readonly runtime?: never }
  | { readonly runtime?: Pick<RuntimeClient, "invoke">; readonly provider?: never });

/** JSON content, stable target-scoped IDs, original scores and source references. */
export function mapContextCandidates(output: RetrievalSearchOutput): readonly ContextItem[] {
  return output.candidates.map(candidate => {
    try {
      messageContent(candidate.content);
      const item = {
        id: stableContextId("retrieval", [output.target.name, output.target.type ?? null, output.target.namespace ?? null,
          candidate.id ?? candidate.source?.ref ?? candidate.content]),
        content: candidate.content,
        ...(candidate.source?.ref ? { source: { uri: candidate.source.ref } } : {}),
        metadata: { ...candidate.metadata, retrievalTarget: output.target.name,
          ...(candidate.score === undefined ? {} : { score: candidate.score }) },
      };
      contextItem(item); return snapshotItem(item);
    }
    catch { throw new ContextError("INVALID_PROVIDER_OUTPUT", "Retrieval candidates require valid Context content or an explicit output mapper"); }
  });
}

/** Opt-in bridge: the same search pipeline can run inline or in a RETRIEVAL Worker. */
export function createRetrievalContextStrategy(options: RetrievalContextOptions): ContextRagStrategy {
  if (options.provider && options.runtime) throw new Error("Choose provider or runtime for Context retrieval");
  validateTarget(options.target);
  const target = structuredClone(options.target), defaults = structuredClone(options.defaults ?? {});
  validateDefaults(defaults);
  const mapInput = options.mapInput, mapOutput = options.mapOutput ?? mapContextCandidates;
  const strategy = options.strategy;
  return Object.freeze({
    async select(input: ContextSelectInput, context: ContextCallOptions = {}) {
      context.signal?.throwIfAborted();
      if (!mapInput && input.strategy?.kind === "rag" && input.strategy.corpus) {
        throw new ContextError("INVALID_INPUT", "A corpus requires an explicit retrieval input mapper");
      }
      if (!mapInput && input.query === undefined) throw new ContextError("INVALID_INPUT", "Retrieval requires a query");
      if (input.limit === 0) return [];
      const request = mapInput ? mapInput(input) : {
        query: { content: input.query }, target: structuredClone(target),
        limit: Math.min(input.limit ?? defaults.searchLimit ?? 10, 10_000),
        ...(strategy === undefined ? {} : { strategy }),
        ...(input.strategy?.kind === "rag" && input.strategy.options ? { options: input.strategy.options } : {}),
      };
      validateSearch(request);
      let output: RetrievalSearchOutput;
      if (options.provider) output = await options.provider.search(request, { ...context, defaults });
      else {
        try {
          const runtime = options.runtime ?? context.runtime;
          if (!runtime) throw new Error("Context retrieval requires a Runtime");
          const result = await runtime.invoke("RETRIEVAL.SEARCH", request, context);
          if (result.status !== "success" || !result.output) throw new Error("Retrieval failed");
          output = result.output;
        } catch {
          context.signal?.throwIfAborted();
          throw new RetrievalError("RETRIEVAL_BACKEND_ERROR", "Context retrieval invocation failed");
        }
      }
      context.signal?.throwIfAborted();
      const items = await mapOutput(normalizeOutput(output, request));
      context.signal?.throwIfAborted();
      return items; // CONTEXT.SELECT enforces item validity, deduplication and final budgets.
    },
  });
}
