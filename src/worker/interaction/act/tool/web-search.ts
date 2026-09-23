import type { JsonObject, JsonValue } from "../../../../contracts/common.js";
import type { RegisteredTool, ToolExecutionOutcome } from "./registry.js";

const BRAVE_ORIGIN = "https://api.search.brave.com";
const BRAVE_ENDPOINT = `${BRAVE_ORIGIN}/res/v1/web/search`;
const MAX_QUERY_LENGTH = 600;
const MAX_QUERY_WORDS = 75;
const MAX_RESULTS = 20;
const DEFAULT_RESULTS = 5;
const MAX_TITLE_LENGTH = 256;
const MAX_SNIPPET_LENGTH = 2_048;

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface WebSearchCallOptions { readonly signal?: AbortSignal; }

export interface WebSearchProvider {
  readonly origin: string;
  search(input: { readonly query: string; readonly limit: number }, options?: WebSearchCallOptions): Promise<readonly WebSearchResult[]>;
}

export interface WebSearchToolOptions {
  readonly provider: WebSearchProvider;
}

export interface BraveWebSearchProviderOptions {
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
}

function exactKeys(input: JsonObject, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  if (Object.keys(input).some(key => !keys.has(key))) throw new Error("Unexpected web_search argument");
}

function request(input: JsonObject): { readonly query: string; readonly limit: number } {
  exactKeys(input, ["query", "limit"]);
  const query = input.query;
  if (typeof query !== "string" || !query.trim() || query.length > MAX_QUERY_LENGTH
    || query.trim().split(/\s+/).length > MAX_QUERY_WORDS || /[\0\r\n]/.test(query)) {
    throw new Error(`query must be a nonempty single-line string of at most ${MAX_QUERY_LENGTH} characters and ${MAX_QUERY_WORDS} words`);
  }
  const limit = input.limit ?? DEFAULT_RESULTS;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new Error(`limit must be an integer from 1 to ${MAX_RESULTS}`);
  }
  return { query: query.trim(), limit };
}

function normalizedOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid web search provider origin");
  }
  return url.origin;
}

function boundedText(value: unknown, name: string, maximum: number, empty = false): { readonly value: string; readonly truncated: boolean } {
  if (typeof value !== "string" || (!empty && !value.trim()) || /\0/.test(value)) throw new Error(`Invalid web search ${name}`);
  const normalized = value.replace(/\s+/g, " ").trim();
  const points = [...normalized];
  return points.length <= maximum
    ? { value: normalized, truncated: false }
    : { value: points.slice(0, maximum).join(""), truncated: true };
}

function resultUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid web search URL");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid web search URL");
  return url.href;
}

function normalizeResults(
  value: unknown,
  limit: number,
): { readonly results: readonly WebSearchResult[]; readonly truncated: boolean } {
  if (!Array.isArray(value)) throw new Error("Invalid web search results");
  let truncated = value.length > limit;
  const results = value.slice(0, limit).map((item): WebSearchResult => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid web search result");
    const record = item as Record<string, unknown>;
    const title = boundedText(record.title, "title", MAX_TITLE_LENGTH);
    const snippet = boundedText(record.snippet, "snippet", MAX_SNIPPET_LENGTH, true);
    truncated ||= title.truncated || snippet.truncated;
    return Object.freeze({ title: title.value, url: resultUrl(record.url), snippet: snippet.value });
  });
  return { results: Object.freeze(results), truncated };
}

/** Optional provider-neutral web search tool. Applications explicitly inject the provider and permissions. */
export function createWebSearchTool(options: WebSearchToolOptions): RegisteredTool {
  const origin = normalizedOrigin(options.provider.origin);
  return {
    name: "web_search",
    description: "Search the public web and return bounded titles, URLs, and snippets",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: MAX_QUERY_LENGTH },
        limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS, default: DEFAULT_RESULTS },
      },
      required: ["query"],
    },
    effects: ["network"],
    requiresApproval: false,
    validate(input) { request(input); },
    async execute(input, context): Promise<ToolExecutionOutcome> {
      const search = request(input);
      context.services.sandbox.assert("network", origin);
      try {
        context.signal?.throwIfAborted();
        const normalized = normalizeResults(await options.provider.search(search, context.signal ? { signal: context.signal } : {}), search.limit);
        context.signal?.throwIfAborted();
        const structuredResults: readonly JsonValue[] = normalized.results.map(result => ({
          title: result.title, url: result.url, snippet: result.snippet,
        }));
        return {
          status: "success",
          structuredContent: { query: search.query, results: structuredResults, truncated: normalized.truncated },
          references: normalized.results.map(result => ({ uri: result.url })),
        };
      } catch {
        if (context.signal?.aborted) return { status: "cancelled", error: { code: "WEB_SEARCH_CANCELLED", message: "Web search cancelled", retryable: false } };
        return {
          status: "failed",
          error: { code: "WEB_SEARCH_FAILED", message: "Web search provider failed", retryable: false },
        };
      }
    },
  };
}

function providerRequest(input: { readonly query: string; readonly limit: number }): void {
  request(input as unknown as JsonObject);
}

function providerOptions(options: BraveWebSearchProviderOptions): number {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!options.apiKey.trim() || /[\r\n]/.test(options.apiKey)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1) {
    throw new Error("Invalid Brave web search configuration");
  }
  return timeoutMs;
}

/** Brave Web Search REST adapter; credentials and request lifecycle stay outside Node payloads. */
export function createBraveWebSearchProvider(options: BraveWebSearchProviderOptions): WebSearchProvider {
  const timeoutMs = providerOptions(options);
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 16 * 1024 * 1024) {
    throw new Error("Invalid Brave maxResponseBytes");
  }
  return {
    origin: BRAVE_ORIGIN,
    async search(input, call = {}) {
      call.signal?.throwIfAborted();
      providerRequest(input);
      const url = new URL(BRAVE_ENDPOINT);
      url.searchParams.set("q", input.query);
      url.searchParams.set("count", String(input.limit));
      const deadline = AbortSignal.timeout(timeoutMs);
      try {
        const response = await (options.fetch ?? globalThis.fetch)(url, {
          method: "GET", redirect: "error", signal: call.signal ? AbortSignal.any([deadline, call.signal]) : deadline,
          headers: { accept: "application/json", "X-Subscription-Token": options.apiKey },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("Brave web search request failed");
        }
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        if (!response.body) throw new Error("Brave web search returned invalid JSON");
        for await (const chunk of response.body) {
          call.signal?.throwIfAborted();
          bytes += chunk.byteLength;
          if (bytes > maxResponseBytes) throw new Error("Brave web search response is too large");
          chunks.push(chunk);
        }
        let raw: unknown;
        try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw new Error("Brave web search returned invalid JSON"); }
        const web = raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>).web : undefined;
        const results = web && typeof web === "object" && !Array.isArray(web)
          ? (web as Record<string, unknown>).results : undefined;
        if (!Array.isArray(results)) throw new Error("Brave web search returned invalid results");
        return results.slice(0, input.limit).map(item => {
          if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Brave web search returned invalid results");
          const result = item as Record<string, JsonValue>;
          if (typeof result.title !== "string" || typeof result.url !== "string"
            || (result.description !== undefined && typeof result.description !== "string")) {
            throw new Error("Brave web search returned invalid results");
          }
          return { title: result.title, url: result.url, snippet: result.description ?? "" };
        });
      } catch (error) {
        if (call.signal?.aborted) throw call.signal.reason;
        if (deadline.aborted) throw new Error("Brave web search timed out");
        if (error instanceof Error && error.message.startsWith("Brave web search")) throw error;
        throw new Error("Brave web search request failed");
      }
    },
  };
}
