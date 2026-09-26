import type { ModelProvider } from "../worker/infer/providers/types.js";
import type { SampleInput } from "../worker/infer/reasoning/sample/types.js";
import type { Usage } from "../worker/infer/types.js";

export interface BudgetScope { readonly runId: string; readonly branchId?: string; readonly label?: string }
export interface BudgetRecord {
  readonly id: number; readonly scope: BudgetScope; readonly reserved: number;
  readonly charged: number; readonly status: "known" | "unknown" | "exceeded";
  readonly usage?: Usage;
}
export class BudgetExceededError extends Error {}

/** Reservations are synchronous and atomic in one JS authority. Share this object across providers. */
export class TokenBudget {
  #spent = 0;
  #reserved = 0;
  #sequence = 0;
  #violated = false;
  readonly #records: BudgetRecord[] = [];
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Token limit must be a positive safe integer");
  }
  get spent(): number { return this.#spent; }
  get remaining(): number { return this.#violated ? 0 : Math.max(0, this.limit - this.#spent - this.#reserved); }
  get records(): readonly BudgetRecord[] { return structuredClone(this.#records); }
  reserve(tokens: number, scope: BudgetScope): (usage?: Usage) => void {
    if (!Number.isSafeInteger(tokens) || tokens < 1 || !scope.runId.trim()) throw new Error("Invalid reservation");
    if (tokens > this.remaining) throw new BudgetExceededError("Insufficient unreserved token budget");
    this.#reserved += tokens;
    const id = this.#sequence++, provenance = structuredClone(scope);
    let settled = false;
    return (usage?: Usage) => {
      if (settled) throw new Error("Reservation already settled");
      settled = true;
      const total = usage?.totalTokens ?? (usage?.inputTokens !== undefined && usage.outputTokens !== undefined
        ? usage.inputTokens + usage.outputTokens : undefined);
      const known = total !== undefined && Number.isSafeInteger(total) && total >= 0;
      const charged = known ? total : tokens;
      this.#reserved -= tokens; this.#spent += charged;
      const exceeded = charged > tokens;
      if (exceeded) this.#violated = true;
      this.#records.push({ id, scope: provenance, reserved: tokens, charged,
        status: exceeded ? "exceeded" : known ? "known" : "unknown", ...(usage ? { usage: structuredClone(usage) } : {}) });
      if (exceeded) throw new BudgetExceededError("Provider exceeded its token reservation; budget closed");
    };
  }
}

export interface BudgetedProviderOptions {
  /** Must bound input + maximum output, including protocol overhead/reasoning tokens.
   * Unknown provider bounds cannot provide a strict physical token guarantee.
   */
  readonly reserveTokens: (input: SampleInput) => number;
  readonly scope: BudgetScope | ((input: SampleInput) => BudgetScope);
  readonly requireUsage?: boolean;
}

/** Failed/cancelled requests without usage retain their reservation as an unknown charge.
 * Streaming intentionally falls back to invoke so accounting has one terminal settlement.
 */
export function budgetedProvider(provider: ModelProvider, budget: TokenBudget, options: BudgetedProviderOptions): ModelProvider {
  return {
    async invoke(input, call) {
      call.signal.throwIfAborted();
      const settle = budget.reserve(options.reserveTokens(input), typeof options.scope === "function" ? options.scope(input) : options.scope);
      let output;
      try { output = await provider.invoke(input, call); }
      catch (error) { settle(); throw error; }
      settle(output.usage);
      const usage = output.usage;
      const total = usage?.totalTokens ?? (usage?.inputTokens !== undefined && usage.outputTokens !== undefined ? usage.inputTokens + usage.outputTokens : undefined);
      if (options.requireUsage && (total === undefined || !Number.isSafeInteger(total) || total < 0))
        throw new Error("Provider usage is unknown; reservation remains charged");
      return output;
    },
  };
}
