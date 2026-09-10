import { randomUUID } from "node:crypto";
import type { Reference } from "../contracts/index.js";

export interface ArtifactStore {
  put(value: unknown): Promise<Reference>;
  get(reference: Reference): Promise<unknown>;
  delete(reference: Reference): Promise<boolean>;
}

/** Process-local storage. Share an external store/resolver for remote hosts. */
export class InMemoryArtifactStore implements ArtifactStore {
  readonly #values = new Map<string, unknown>();

  async put(value: unknown): Promise<Reference> {
    const uri = `ditto://artifact/${randomUUID()}`;
    this.#values.set(uri, value);
    return { uri };
  }

  async get(reference: Reference): Promise<unknown> {
    if (!this.#values.has(reference.uri)) {
      throw new Error(`Artifact not found: ${reference.uri}`);
    }
    return this.#values.get(reference.uri);
  }

  async delete(reference: Reference): Promise<boolean> {
    return this.#values.delete(reference.uri);
  }
}

export type Payload =
  | { readonly kind: "inline"; readonly value: unknown }
  | { readonly kind: "reference"; readonly reference: Reference };

/** Used only at transport boundaries. Direct calls do not serialize or size data. */
export class PayloadCodec {
  constructor(
    readonly artifacts?: ArtifactStore,
    readonly inlineLimitBytes = 64 * 1024,
  ) {
    if (!Number.isFinite(inlineLimitBytes) || inlineLimitBytes < 0) {
      throw new Error("inlineLimitBytes must be finite and non-negative");
    }
  }

  async encode(value: unknown): Promise<Payload> {
    if (this.artifacts) {
      const json = JSON.stringify(value);
      if (json !== undefined && Buffer.byteLength(json, "utf8") > this.inlineLimitBytes) {
        return { kind: "reference", reference: await this.artifacts.put(value) };
      }
    }
    return { kind: "inline", value };
  }

  async decode(payload: Payload): Promise<unknown> {
    if (payload.kind === "inline") return payload.value;
    if (payload.kind !== "reference") throw new Error("Unsupported payload kind");
    if (!this.artifacts) throw new Error("Reference payload requires an ArtifactStore");
    return this.artifacts.get(payload.reference);
  }
}
