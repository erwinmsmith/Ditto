import type { ModelProvider, ProviderResolver } from "./types.js";
import { InferError } from "../validation.js";
export class ProviderRegistry implements ProviderResolver {
  readonly #providers = new Map<string, ModelProvider>();
  constructor(providers: Readonly<Record<string, ModelProvider>> = {}) {
    for (const [name, provider] of Object.entries(providers)) this.register(name, provider);
  }
  register(name: string, provider: ModelProvider): () => boolean {
    if (!name.trim() || this.#providers.has(name)) throw new Error(`Duplicate or empty provider: ${name}`);
    this.#providers.set(name, provider);
    return () => this.#providers.get(name) === provider && this.#providers.delete(name);
  }
  get(name?: string): ModelProvider {
    const selected = name ?? (this.#providers.size === 1 ? this.#providers.keys().next().value : undefined);
    const provider = selected === undefined ? undefined : this.#providers.get(selected);
    if (!provider) throw new InferError("PROVIDER_NOT_FOUND", `Provider is not configured or ambiguous: ${selected ?? "(default)"}`);
    return provider;
  }
}
