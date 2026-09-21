import type { Sandbox } from "../../../../runtime/sandbox/index.js";
import { RetrievalError } from "../../types.js";
import type { EmbeddingProvider } from "./types.js";
import { validateVector } from "./embedding.js";

export interface HttpEmbeddingOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly sandbox: Pick<Sandbox, "assert">;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}
/** OpenAI-compatible wire protocol; no model/vendor SDK or inference Worker dependency. */
export function createHttpEmbeddingProvider(options: HttpEmbeddingOptions): EmbeddingProvider {
  const url = new URL(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !options.model.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1) {
    throw new RetrievalError("RETRIEVAL_INVALID_INPUT", "Invalid embedding provider configuration");
  }
  const endpoint = url.href.replace(/\/$/, "") + "/embeddings";
  return { async embed(input, context = {}) {
    context.signal?.throwIfAborted();
    if (!input.contents.every(value => typeof value === "string" && value.trim())) {
      throw new RetrievalError("RETRIEVAL_INVALID_INPUT", "HTTP embedding requires nonempty strings");
    }
    if (!input.contents.length) return [];
    try { options.sandbox.assert("network", url.origin); }
    catch { throw new RetrievalError("RETRIEVAL_PERMISSION_DENIED", "Embedding endpoint is not permitted"); }
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
    try {
      const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
        method: "POST", redirect: "error", signal,
        headers: { "content-type": "application/json", ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
        body: JSON.stringify({ model: options.model, input: input.contents, encoding_format: "float" }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new RetrievalError("RETRIEVAL_BACKEND_ERROR", `Embedding provider returned HTTP ${response.status}`);
      }
      const raw = await response.json() as { data?: { index: number; embedding: unknown }[] };
      signal.throwIfAborted();
      if (!Array.isArray(raw?.data) || raw.data.length !== input.contents.length) {
        throw new RetrievalError("RETRIEVAL_INVALID_EMBEDDING", "Invalid embedding response count");
      }
      const vectors: (readonly number[])[] = new Array(input.contents.length);
      let dimensions: number | undefined;
      for (const item of raw.data) {
        if (!item || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= vectors.length || vectors[item.index]) {
          throw new RetrievalError("RETRIEVAL_INVALID_EMBEDDING", "Invalid embedding response index");
        }
        validateVector(item.embedding, dimensions);
        dimensions ??= item.embedding.length;
        vectors[item.index] = item.embedding;
      }
      return vectors;
    } catch (error) {
      context.signal?.throwIfAborted();
      if (deadline.aborted) throw new RetrievalError("RETRIEVAL_TIMEOUT", "Embedding request timed out");
      if (error instanceof RetrievalError) throw error;
      throw new RetrievalError("RETRIEVAL_BACKEND_ERROR", "Embedding request failed");
    }
  } };
}

/** Explicit opt-in to the root env layout; numerical execution policy stays in YAML. */
export function embeddingConfigFromEnv(env: Readonly<Record<string, string | undefined>>): Pick<HttpEmbeddingOptions, "baseUrl" | "model" | "apiKey"> {
  const baseUrl = env.DITTO_WORKER_RETRIEVAL_EMBEDDING_BASE_URL;
  const model = env.DITTO_WORKER_RETRIEVAL_EMBEDDING_MODEL;
  if (!baseUrl || !model) throw new RetrievalError("RETRIEVAL_INVALID_INPUT", "Missing retrieval embedding endpoint or model");
  const apiKey = env.DITTO_WORKER_RETRIEVAL_EMBEDDING_API_KEY;
  return { baseUrl, model, ...(apiKey ? { apiKey } : {}) };
}
