import {
  createBraveWebSearchProvider,
  type WebSearchProvider,
} from "@codesoul-co/ditto/worker/interaction";
import { download, type TransportOptions } from "./http.ts";
import { object } from "./domain.ts";
export interface SearchConfig {
  engine: "brave" | "mediawiki";
  endpoint?: string;
  apiKey?: string;
}
export function searchProvider(
  config: SearchConfig,
  transport: TransportOptions = {},
): WebSearchProvider {
  if (config.engine === "brave") {
    if (!config.apiKey)
      throw new Error(
        "Configure DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY",
      );
    return createBraveWebSearchProvider({ apiKey: config.apiKey });
  }
  const endpoint = new URL(
    config.endpoint ?? "https://en.wikipedia.org/w/api.php",
  );
  return {
    origin: endpoint.origin,
    async search(input, options) {
      const url = new URL(endpoint);
      url.search = new URLSearchParams({
        action: "query",
        list: "search",
        srsearch: input.query,
        srwhat: "text",
        srlimit: String(input.limit),
        format: "json",
      }).toString();
      const raw = await download(
        url.href,
        [url.origin],
        "json",
        transport,
        options?.signal,
      );
      const payload = object(JSON.parse(raw.body)),
        rows = object(payload.query).search;
      if (!Array.isArray(rows))
        throw new Error("Invalid MediaWiki search response");
      return rows.map((v) => {
        const row = object(v);
        if (typeof row.title !== "string" || typeof row.snippet !== "string")
          throw new Error("Invalid search hit");
        return {
          title: row.title,
          url: new URL(
            `/wiki/${encodeURIComponent(row.title.replaceAll(" ", "_"))}`,
            endpoint,
          ).href,
          snippet: row.snippet.replace(/<[^>]*>/g, ""),
        };
      });
    },
  };
}
export function searchConfig(): SearchConfig {
  const engine = process.env.DITTO_EXAMPLE_WEB_SEARCH_ENGINE ?? "mediawiki";
  if (engine !== "brave" && engine !== "mediawiki")
    throw new Error("Choose brave or mediawiki");
  return {
    engine,
    ...(process.env.DITTO_EXAMPLE_WEB_SEARCH_ENDPOINT
      ? { endpoint: process.env.DITTO_EXAMPLE_WEB_SEARCH_ENDPOINT }
      : {}),
    ...(process.env.DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY
      ? { apiKey: process.env.DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY }
      : {}),
  };
}
