import type { RetrievalExecutionContext } from "../search/providers/types.js";
import type { RetrievalTarget } from "../types.js";
import type { RetrievalSearchInput, RetrievalSearchOutput } from "../search/types.js";

export interface RetrievalSearchProvider {
  search(input: RetrievalSearchInput, context?: RetrievalExecutionContext): Promise<RetrievalSearchOutput>;
}
/** Custom registries may enforce tenant/namespace permissions before resolving a backend. */
export interface RetrievalProviderRegistry {
  resolve(target: RetrievalTarget, strategy?: string): RetrievalSearchProvider;
}
export interface RetrievalResources { readonly providers: RetrievalProviderRegistry; }
