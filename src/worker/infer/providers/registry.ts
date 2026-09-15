import type { ModelProvider, ProviderResolver } from "../../../contracts/common.js";

export class ProviderRegistry implements ProviderResolver {
  readonly #providers = new Map<string, ModelProvider>();

  register(name: string, provider: ModelProvider): () => boolean {
    if (!name || this.#providers.has(name)) throw new Error(`Duplicate or empty provider: ${name}`);
    this.#providers.set(name, provider);
    return () => this.#providers.get(name) === provider && this.#providers.delete(name);
  }

  get(name: string): ModelProvider {
    const provider = this.#providers.get(name);
    if (!provider) throw new Error(`Provider is not installed: ${name}`);
    return provider;
  }
}
