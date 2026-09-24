import { lstat, readFile, mkdir, writeFile, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import { document, json, object, type Request } from "./domain.ts";
async function immutable(path: string, text: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, text, { flag: "wx" }); try { await link(temp, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(path, "utf8") !== text) throw error; } }
  finally { await rm(temp, { force: true }); }
}
/** Application-owned input admission and artifact publishing, separate from Core. */
export function contextTools(directory: string, r: Request): RegisteredTool[] {
  return [
    { name: "context_document", effects: ["read"], inputSchema: { type: "object" },
      validate(args) { if (!["initial", "revision"].includes(String(args.version))) throw new Error("Unknown document version"); },
      async execute(args, context) { context.signal?.throwIfAborted(); const path = join(directory, args.version === "revision" ? "revision.json" : "document.json"), stat = await lstat(path); if (!stat.isFile() || stat.size > 16384) throw new Error("Invalid document file"); return { status: "success", structuredContent: { data: document(JSON.parse(await readFile(path, "utf8"))), uri: pathToFileURL(path).href } }; } },
    { name: "context_search", effects: ["read"], inputSchema: { type: "object" },
      validate(args) { if (typeof args.releaseCode !== "string") throw new Error("Missing search query"); },
      async execute(args, context) {
        const url = new URL(r.searchUrl); url.searchParams.set("q", String(args.releaseCode)); context.services.sandbox.assert("network", url.origin);
        const response = await fetch(url, { redirect: "error", signal: context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
        if (!response.ok || !response.body) throw new Error("Search source unavailable");
        const chunks: Uint8Array[] = []; let size = 0; const reader = response.body.getReader();
        try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 16384) throw new Error("Search response too large"); chunks.push(part.value); } } finally { await reader.cancel(); }
        const data = object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); if (data.releaseCode !== args.releaseCode || typeof data.region !== "string" || !/^[a-z-]{2,30}$/.test(data.region)) throw new Error("Search result does not match request");
        return { status: "success", structuredContent: { data: { releaseCode: String(data.releaseCode), region: data.region }, uri: url.href } };
      } },
    { name: "context_publish", effects: ["write"], inputSchema: { type: "object" }, validate(args) { object(args.report); },
      async execute(args, context) { context.signal?.throwIfAborted(); const report = object(args.report); if (report.requestId !== r.id) throw new Error("Wrong report task"); const dir = join(directory, "artifacts"); await mkdir(dir, { recursive: true }); await immutable(join(dir, "brief.json"), JSON.stringify(json(report), null, 2) + "\n"); return { status: "success", structuredContent: { file: "artifacts/brief.json" } }; } },
  ];
}
