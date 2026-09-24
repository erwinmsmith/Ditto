/** Application-owned HTML decoder and HTTP transport. No browser scripts are executed. */
import { createRequire } from "node:module";
import type { WebSearchProvider } from "@ditto/core/worker/interaction";
import { digest, object, tokens, type Evidence } from "./domain.ts";
interface Element { textContent: string | null; querySelectorAll(selector: string): Element[]; querySelector(selector: string): Element | null; remove(): void }
const require = createRequire(new URL("./dependencies/package.json", import.meta.url));
function parseHTML(html: string): { document: Element } {
  const decoder = require("linkedom") as { parseHTML(html: string): { document: Element } };
  return decoder.parseHTML(html);
}
export function readable(html: string): { title: string; blocks: string[] } {
  const { document } = parseHTML(html);
  const title = document.querySelector("title")?.textContent?.trim() ?? "Web page";
  for (const node of document.querySelectorAll("script,style,noscript,nav,header,footer,aside,form,iframe,svg,.mw-editsection,.reflist,.reference")) node.remove();
  const main = document.querySelector("main") ?? document.querySelector("article") ?? document.querySelector("body") ?? document;
  const blocks = main.querySelectorAll("p,pre").map(n => (n.textContent ?? "").replace(/\s+/g, " ").trim()).filter(t => t.length >= 40);
  if (!blocks.length) throw new Error("No readable page content");
  return { title, blocks };
}
export function approvedUrl(value: string, origins: readonly string[]): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !origins.includes(url.origin)) throw new Error("Page origin not allowed");
  url.hash = "";
  return url;
}
export async function download(url: URL, kind: "html" | "json", signal?: AbortSignal): Promise<string> {
  const deadline = AbortSignal.timeout(20000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const response = await fetch(url, { signal: combined, redirect: "error", headers: { "User-Agent": "DittoRetrievalExample/1.0", Accept: kind === "html" ? "text/html" : "application/json" } });
  if (!response.ok) { await response.body?.cancel(); throw new Error("HTTP source unavailable"); }
  if (!response.headers.get("content-type")?.includes(kind === "html" ? "text/html" : "application/json")) { await response.body?.cancel(); throw new Error("Unexpected HTTP content type"); }
  if (!response.body) throw new Error("Empty HTTP body");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 4 * 1024 * 1024) throw new Error("HTTP body exceeds limit"); chunks.push(value); } }
  finally { await reader.cancel(); reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
export function wikipediaSearch(): WebSearchProvider {
  return { origin: "https://en.wikipedia.org", async search(input, options) {
    const url = new URL("https://en.wikipedia.org/w/api.php");
    url.search = new URLSearchParams({ action: "query", list: "search", srsearch: input.query, srwhat: "text", srlimit: String(input.limit), format: "json" }).toString();
    const payload = object(JSON.parse(await download(url, "json", options?.signal))), rows = object(payload.query).search;
    if (!Array.isArray(rows)) throw new Error("Invalid search response");
    return rows.map(value => { const row = object(value); if (typeof row.title !== "string" || typeof row.snippet !== "string") throw new Error("Invalid search hit");
      return { title: row.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(row.title.replaceAll(" ", "_"))}`, snippet: parseHTML(`<p>${row.snippet}</p>`).document.textContent ?? "" };
    });
  } };
}
export function pageEvidence(url: string, html: string, query: string): { evidence: Evidence[]; snapshot: string; extracted: string } {
  const { title, blocks } = readable(html), extracted = blocks.join("\n"), snapshot = digest(html);
  const words = tokens(query);
  const ranked = blocks.map((content, index) => ({ content, index, score: words.reduce((n, w) => n + Number(content.toLowerCase().includes(w)), 0) })).filter(v => v.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 2);
  return { snapshot, extracted, evidence: ranked.map(({ content, index }) => ({ id: `web-${digest(url + snapshot + index).slice(0, 24)}`, source: "web", uri: url, title, text: content.slice(0, 1000), location: `extracted.txt line ${index + 1}, characters 1-${Math.min(content.length, 1000)}`, snapshot, queries: [query] })) };
}
