import { RetrievalError, type RetrievalTarget } from "../types.js";
import type { RetrievalProviderRegistry, RetrievalSearchProvider } from "./providers.js";
import { nonempty, validateTarget } from "../search/schema.js";

export interface RetrievalTargetBinding {
  readonly defaultStrategy: string;
  readonly providers: Readonly<Record<string, RetrievalSearchProvider>>;
}

/** Immutable startup bindings. No connection creation, target discovery or routing by URL. */
export class RetrievalTargetRegistry implements RetrievalProviderRegistry {
  readonly #targets = new Map<string, { defaultStrategy: string; providers: Map<string, RetrievalSearchProvider> }>();

  constructor(targets: Readonly<Record<string, RetrievalTargetBinding>>) {
    for (const [name, binding] of Object.entries(targets)) {
      nonempty(name, "target name");
      nonempty(binding.defaultStrategy, "defaultStrategy");
      const providers = new Map<string, RetrievalSearchProvider>();
      for (const [strategy, provider] of Object.entries(binding.providers)) {
        nonempty(strategy, "strategy");
        if (strategy.trim().toLowerCase() === "rag") throw new RetrievalError("RETRIEVAL_STRATEGY_UNSUPPORTED", "RAG is a Graph, not a search strategy");
        if (!provider || typeof provider.search !== "function") throw new RetrievalError("RETRIEVAL_PROVIDER_UNAVAILABLE", "Search provider is unavailable");
        providers.set(strategy, {
          async search(input) {
            const output = await provider.search({ ...input, strategy });
            if (!output || typeof output !== "object" || (output.strategy !== undefined && output.strategy !== strategy)) {
              throw new RetrievalError("RETRIEVAL_INVALID_BACKEND_OUTPUT", "Retrieval backend returned an invalid strategy");
            }
            return { ...output, strategy };
          },
        });
      }
      if (!providers.has(binding.defaultStrategy)) throw new RetrievalError("RETRIEVAL_STRATEGY_UNSUPPORTED", "Default strategy is not registered");
      this.#targets.set(name, { defaultStrategy: binding.defaultStrategy, providers });
    }
  }

  resolve(target: RetrievalTarget, strategy?: string): RetrievalSearchProvider {
    validateTarget(target);
    const binding = this.#targets.get(target.name);
    if (!binding) throw new RetrievalError("RETRIEVAL_TARGET_NOT_FOUND", "Retrieval target is not registered");
    const provider = binding.providers.get(strategy ?? binding.defaultStrategy);
    if (!provider) throw new RetrievalError("RETRIEVAL_STRATEGY_UNSUPPORTED", "Search strategy is not registered for this target");
    return provider;
  }
}
