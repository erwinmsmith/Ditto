import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFile, lstat, mkdir, writeFile, link, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import { createSqlSearchProvider, RetrievalTargetRegistry } from "@codesoul-co/ditto-retrieval";
import { createFileTools, type FileToolConfig } from "../file-ingestion/index.ts";
import { download, readable } from "../retrieval/web.ts";
import { compileReport, digest, json, object, renderReport, text, type Source, type Request, type Material, type Block, type Report } from "./domain.ts";
export async function immutable(path: string, content: string | Uint8Array) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content, { flag: "wx" }); try { await link(temporary, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await readFile(path)).equals(Buffer.from(content))) throw error; } }
  finally { await rm(temporary, { force: true }); }
}
export interface Raw { sourceId: string; snapshot: string; uri: string; path?: string; text?: string }
export class AnalysisAdapters {
  readonly directory: string; readonly request: Request; readonly config: FileToolConfig; readonly db: DatabaseSync | undefined;
  constructor(directory: string, request: Request, python: string) {
    this.directory = resolve(directory); this.request = request;
    this.config = { root: this.directory, python, pdftotext: process.env.DITTO_EXAMPLE_PDFTOTEXT ?? "pdftotext", tesseract: process.env.DITTO_EXAMPLE_TESSERACT ?? "tesseract" };
    this.db = request.sources.some(s => s.format === "external") ? new DatabaseSync(join(directory, "knowledge.sqlite"), { readOnly: true }) : undefined;
  }
  private source(id: unknown) { const s = this.request.sources.find(s => s.id === id); if (!s) throw new Error("Unknown admitted source"); return s; }
  private async snapshot(bytes: string | Uint8Array) { const hash = digest(bytes), directory = join(this.directory, "snapshots", hash); await mkdir(directory, { recursive: true }); await immutable(join(directory, "source.bin"), bytes); return hash; }
  get providers() {
    const provider = createSqlSearchProvider<Record<string, unknown>>({
      prepare: input => { const id = text(input.query.content, 128); if (input.target.namespace !== this.request.tenant || !this.request.sources.some(s => s.format === "external" && s.locator === id)) throw new Error("External knowledge scope denied"); return { text: "SELECT id,tenant,body FROM documents WHERE id=? AND tenant=?", values: [id, this.request.tenant] }; },
      query: async (statement, context) => { context.signal?.throwIfAborted(); if (!this.db) throw new Error("External knowledge unavailable"); return this.db.prepare(statement.text).all(...statement.values as SQLInputValue[]); },
      mapRow: row => ({ id: String(row.id), content: row, source: { target: "knowledge-external", ref: `sqlite:knowledge-external/documents/${row.id}` } }),
    });
    return new RetrievalTargetRegistry({ "knowledge-external": { defaultStrategy: "lookup", providers: { lookup: provider } } });
  }
  private async normalize(s: Source, args: Record<string, unknown>): Promise<Material> {
    let snapshot: string, uri: string, engine: string, lines: { text: string; location: string }[] = [];
    if (s.format === "memory") {
      if (!Array.isArray(args.hits) || args.hits.length !== 1) throw new Error("Internal knowledge unavailable");
      const memory = object(object(args.hits[0]).memory), content = object(memory.content);
      if (memory.key !== s.locator || content.kind !== "knowledge" || content.tenant !== this.request.tenant) throw new Error("Internal knowledge scope denied");
      const body = text(content.text); snapshot = await this.snapshot(JSON.stringify(memory)); uri = `memory:${s.locator}`; engine = "MEMORY.SEARCH";
      lines = [{ text: body, location: `memory id=${memory.id}, key=${s.locator}, content.text` }];
    } else if (s.format === "external") {
      if (!Array.isArray(args.candidates) || args.candidates.length !== 1) throw new Error("External knowledge unavailable");
      const row = object(object(args.candidates[0]).content); if (row.id !== s.locator || row.tenant !== this.request.tenant) throw new Error("External knowledge scope denied");
      snapshot = await this.snapshot(JSON.stringify(row)); uri = `sqlite:knowledge-external/documents/${s.locator}`; engine = "SQLite lookup";
      lines = [{ text: text(row.body), location: `documents id=${s.locator}, tenant=${row.tenant}, body` }];
    } else {
      const raw = object(args.raw) as unknown as Raw; if (raw.sourceId !== s.id) throw new Error("Source identity mismatch"); snapshot = raw.snapshot; uri = raw.uri;
      if (["pdf", "image", "csv", "xlsx"].includes(s.format)) {
        const decoded = object(args.decoded); if (decoded.sourceSha256 !== snapshot) throw new Error("Source changed during decoding"); engine = text(decoded.engine);
        if (s.format === "csv" || s.format === "xlsx") {
          if (!Array.isArray(decoded.rows) || decoded.rows.length < 2) throw new Error("Empty table");
          const header = decoded.rows[0] as unknown[]; if (JSON.stringify(header) !== JSON.stringify(["subject", "retention", "storage"])) throw new Error("Expected subject,retention,storage columns");
          decoded.rows.slice(1).forEach((row, index) => { if (!Array.isArray(row) || row.length !== 3) throw new Error("Invalid table row"); for (const [column, label] of [[1, "retention"], [2, "storage"]] as const) lines.push({ text: `${text(row[0])} ${label} is ${text(row[column])}.`, location: `sheet 1, row ${index + 2}, column ${column + 1} (${label})` }); });
        } else if (s.format === "pdf") {
          if (typeof decoded.text !== "string") throw new Error("Invalid decoded PDF");
          decoded.text.split("\f").forEach((page, index) => page.split(/\r?\n/).forEach((line, row) => { if (line.trim()) lines.push({ text: line.trim(), location: `page ${index + 1}, extracted line ${row + 1}` }); }));
        } else {
          if (typeof decoded.ocrText !== "string") throw new Error("Invalid OCR result");
          lines = decoded.ocrText.split(/\r?\n/).map((line, index) => ({ text: line.trim(), location: `OCR line ${index + 1} (not pixel coordinates)` })).filter(l => l.text);
        }
      } else if (s.format === "web") { engine = "HTTP + LinkeDOM"; lines = readable(raw.text!).blocks.map((line, index) => ({ text: line, location: `body paragraph ${index + 1}` })); }
      else { engine = "UTF-8 text"; lines = raw.text!.split(/\r?\n/).map((line, index) => ({ text: line.trim(), location: `line ${index + 1}` })).filter(l => l.text); }
    }
    if (!lines.length || lines.length > 30 || lines.some(l => l.text.length > 1200)) throw new Error("Source exceeds extraction bounds or is empty");
    const blocks: Block[] = lines.map((line, index) => ({ id: `${s.id}-${index + 1}`, sourceId: s.id, ...line, snapshot }));
    await immutable(join(this.directory, "snapshots", snapshot, `${s.id}-extracted.json`), JSON.stringify(blocks, null, 2));
    return { blocks, sources: [{ id: s.id, snapshot, engine, uri }] };
  }
  get tools(): RegisteredTool[] {
    const tool = (name: string, execute: RegisteredTool["execute"]): RegisteredTool => ({ name, effects: ["read", "write"], inputSchema: { type: "object" }, validate(args) { object(args); }, execute });
    return [...createFileTools(this.config).filter(t => t.name !== "transcribe_audio"),
      tool("analysis_read", async (args, context) => {
        const s = this.source(args.sourceId); let raw: Raw;
        if (s.format === "web") { const url = new URL(s.locator); if (!this.request.allowedOrigins.includes(url.origin)) throw new Error("Page origin denied"); context.services.sandbox.assert("network", url.origin); const html = await download(url, "html", context.signal); raw = { sourceId: s.id, snapshot: await this.snapshot(html), uri: url.href, text: html }; }
        else { const path = join(this.directory, s.locator), stat = await lstat(path); if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("Invalid source file"); const bytes = await readFile(path); raw = { sourceId: s.id, snapshot: await this.snapshot(bytes), uri: pathToFileURL(path).href, path, ...(["text"].includes(s.format) ? { text: bytes.toString("utf8") } : {}) }; }
        return { status: "success", structuredContent: json(raw) };
      }),
      tool("analysis_normalize", async (args, context) => { context.signal?.throwIfAborted(); return { status: "success", structuredContent: json(await this.normalize(this.source(args.sourceId), args)) }; }),
      tool("analysis_report", async (args, context) => { context.signal?.throwIfAborted(); return { status: "success", structuredContent: json(compileReport(this.request, args.material as unknown as Material, args.proposal)) }; }),
      tool("analysis_publish", async (args, context) => {
        context.signal?.throwIfAborted(); const report = object(args.report) as unknown as Report; if (report.requestId !== this.request.id) throw new Error("Report identity mismatch");
        const { csv, markdown } = renderReport(report), dir = join(this.directory, "artifacts"); await mkdir(dir, { recursive: true });
        await immutable(join(dir, "analysis.json"), JSON.stringify(report, null, 2) + "\n"); await immutable(join(dir, "facts.csv"), csv); await immutable(join(dir, "analysis.md"), markdown);
        return { status: "success", structuredContent: { files: ["analysis.json", "facts.csv", "analysis.md"] } };
      }),
    ];
  }
  close() { this.db?.close(); }
}
