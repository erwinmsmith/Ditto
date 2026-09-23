import { RetrievalError, type RetrievalCandidate } from "../../types.js";
import type { RetrievalSearchProvider } from "../../registry/providers.js";
import { normalizeOutput, validateLimit } from "../schema.js";

export interface HybridBranch { readonly provider: RetrievalSearchProvider; readonly strategy: string; readonly weight?: number; }
export interface HybridProviderOptions {
  readonly branches: readonly HybridBranch[];
  readonly candidateLimit?: number;
  readonly rrfK?: number;
  readonly key?: (candidate: RetrievalCandidate) => string;
}
/** Parallel backend searches followed by weighted reciprocal-rank fusion, without mixing raw score scales. */
export function createHybridSearchProvider(options: HybridProviderOptions): RetrievalSearchProvider {
  if (!options.branches.length) throw new RetrievalError("RETRIEVAL_INVALID_INPUT", "Hybrid search requires branches");
  const branches = options.branches.map(branch => {
    const weight = branch.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0 || !branch.strategy.trim()) throw new RetrievalError("RETRIEVAL_INVALID_INPUT", "Invalid hybrid branch");
    return { ...branch, weight };
  });
  return { async search(input, context = {}) {
    const limit = input.limit ?? context.defaults?.searchLimit ?? 10;
    const pool = options.candidateLimit ?? context.defaults?.hybrid?.candidateLimit ?? 100;
    validateLimit(pool);
    const candidateLimit = Math.max(limit, pool);
    const k = options.rrfK ?? context.defaults?.hybrid?.rrfK ?? 60;
    validateLimit(limit);
    validateLimit(candidateLimit);
    if (!Number.isSafeInteger(k) || k < 1) throw new RetrievalError("RETRIEVAL_INVALID_INPUT", "rrfK must be a positive integer");
    context.signal?.throwIfAborted();
    const settled = await Promise.allSettled(branches.map(async branch => {
      const request = { ...input, strategy: branch.strategy, limit: candidateLimit };
      return normalizeOutput(await branch.provider.search(request, context), request);
    }));
    context.signal?.throwIfAborted();
    const outputs = settled.map(result => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const fused = new Map<string, { candidate: RetrievalCandidate; score: number; contributions: { strategy: string; rank: number; score?: number; weight: number; source?: RetrievalCandidate["source"]; metadata?: RetrievalCandidate["metadata"] }[] }>();
    outputs.forEach((result, branchIndex) => {
      const seen = new Set<string>();
      result.candidates.forEach((candidate, index) => {
        const identity = candidate.id ?? candidate.source?.ref;
        const key = options.key?.(candidate) ?? (identity === undefined ? undefined : JSON.stringify([candidate.source?.target ?? input.target.name, identity]));
        if (!key) throw new RetrievalError("RETRIEVAL_INVALID_BACKEND_OUTPUT", "Hybrid candidates require an id, source ref or explicit identity mapper");
        if (seen.has(key)) return;
        seen.add(key);
        const entry = fused.get(key) ?? { candidate, score: 0, contributions: [] };
        entry.score += branches[branchIndex]!.weight / (k + index + 1);
        entry.contributions.push({ strategy: branches[branchIndex]!.strategy, rank: index + 1, weight: branches[branchIndex]!.weight,
          ...(candidate.source === undefined ? {} : { source: candidate.source }),
          ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
          ...(candidate.score === undefined ? {} : { score: candidate.score }) });
        fused.set(key, entry);
      });
    });
    const entries = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
    return { target: input.target, ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
      candidates: entries.map(([, value]) => ({ ...value.candidate, score: value.score })),
      metadata: { fusion: { method: "rrf", k, contributions: Object.fromEntries(entries.map(([key, value]) => [key, value.contributions])),
        branches: outputs.map(result => result.metadata ?? {}) } },
    };
  } };
}
