import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { lstat, readFile, mkdir, writeFile, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createSqlSearchProvider, createTextSearchProvider, RetrievalTargetRegistry, type RetrievalCandidate, type RetrievalSearchProvider } from "@ditto/core/worker/retrieval";
import { createBraveWebSearchProvider, createWebSearchTool, type RegisteredTool } from "@ditto/core/worker/interaction";
import { approvedUrl, download, pageEvidence, wikipediaSearch } from "./web.ts";
import { digest, json, object, text, tokens, type Evidence, type Request, type Report, sourceList } from "./domain.ts";
export async function immutable(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content, { flag: "wx" }); try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(path, "utf8") !== content) throw error; }
  } finally { await rm(temporary, { force: true }); }
}
const candidate = (e: Evidence): RetrievalCandidate => ({ id: e.id, content: e.text, source: { target: e.source, ref: e.uri }, metadata: { evidence: e } });
export class RetrievalAdapters {
  readonly directory: string; readonly request: Request; readonly db: DatabaseSync | undefined;
  constructor(directory: string, request: Request) {
    this.directory = directory; this.request = request;
    this.db = sourceList(request).includes("knowledge-external") ? new DatabaseSync(join(directory, "knowledge.sqlite"), { readOnly: true }) : undefined;
  }
  private namespace(namespace: string | undefined) { if (namespace !== this.request.tenant) throw new Error("Knowledge namespace denied"); }
  private async snapshot(hash: string, filename: string, content: string) {
    const directory = join(this.directory, "snapshots", hash); await mkdir(directory, { recursive: true });
    await immutable(join(directory, filename), content);
  }
  get providers(): RetrievalTargetRegistry {
    const documents: RetrievalSearchProvider = createTextSearchProvider({ search: async (input, context) => {
      this.namespace(input.target.namespace); const query = text(input.query.content, 200), words = tokens(query), evidence: Evidence[] = [];
      for (const file of this.request.documents) {
        context?.signal?.throwIfAborted(); const path = join(this.directory, file), stat = await lstat(path);
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid document file");
        const raw = await readFile(path, "utf8"), snapshot = digest(raw); await this.snapshot(snapshot, "document.md", raw);
        const lines = raw.split(/\r?\n/);
        lines.forEach((line, index) => { if (line.length < 20 || !words.length || !words.every(w => line.toLowerCase().includes(w))) return;
          evidence.push({ id: `doc-${digest(file + snapshot + index).slice(0, 24)}`, source: "documents", uri: pathToFileURL(path).href, title: file, text: line.slice(0, 1000), location: `line ${index + 1}, characters 1-${Math.min(line.length, 1000)}`, snapshot, queries: [query] });
        });
      }
      return { target: input.target, candidates: evidence.slice(0, input.limit ?? 3).map(candidate) };
    } });
    const knowledge = createSqlSearchProvider<Record<string, unknown>>({
      prepare: input => {
        this.namespace(input.target.namespace); const words = tokens(text(input.query.content, 200)); if (!words.length) throw new Error("Empty FTS query");
        return { text: "SELECT rowid, title, body, tenant FROM articles WHERE articles MATCH ? AND tenant = ? ORDER BY bm25(articles), rowid LIMIT ?", values: [words.map(w => `"${w.replaceAll('"', '""')}"`).join(" AND "), this.request.tenant, input.limit ?? 3] };
      },
      query: async (statement, context) => { context.signal?.throwIfAborted(); const rows = this.db!.prepare(statement.text).all(...statement.values as SQLInputValue[]);
        for (const row of rows) await this.snapshot(digest(JSON.stringify(row)), "record.json", JSON.stringify(row));
        return rows;
      },
      mapRow: row => candidate({ id: `kb-${row.rowid}-${digest(String(row.body)).slice(0, 16)}`, source: "knowledge-external", uri: `sqlite:knowledge-external/articles/${row.rowid}`, title: String(row.title), text: String(row.body).slice(0, 1000), location: `articles rowid=${row.rowid}, tenant=${this.request.tenant}, column=body`, snapshot: digest(JSON.stringify(row)), queries: [] }),
    });
    return new RetrievalTargetRegistry({ documents: { defaultStrategy: "keyword", providers: { keyword: documents } }, ...(this.db ? { "knowledge-external": { defaultStrategy: "fts5", providers: { fts5: knowledge } } } : {}) });
  }
  get tools(): RegisteredTool[] {
    const engine = this.request.searchEngine === "brave"
      ? createBraveWebSearchProvider({ apiKey: process.env.DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY ?? "" }) : wikipediaSearch();
    const tool = (name: string, effects: ("read" | "write")[], execute: RegisteredTool["execute"]): RegisteredTool => ({ name, effects, inputSchema: { type: "object" }, validate(args) { object(args); }, execute });
    return [createWebSearchTool({ provider: engine }),
      tool("retrieval_snapshot_memory", ["write"], async (args, context) => {
        context.signal?.throwIfAborted(); const memory = object(args.memory), content = object(memory.content);
        if (content.kind !== "knowledge" || content.tenant !== this.request.tenant || !this.request.internalKnowledgeKeys.includes(String(memory.key))) throw new Error("Invalid internal knowledge snapshot");
        const raw = JSON.stringify(memory), snapshot = digest(raw); await this.snapshot(snapshot, "memory.json", raw);
        return { status: "success", structuredContent: json({ snapshot }) };
      }),
      tool("retrieval_read_page", ["read", "write"], async (args, context) => {
        const url = approvedUrl(text(args.url, 2048), this.request.allowedOrigins); context.services.sandbox.assert("network", url.origin);
        const raw = await download(url, "html", context.signal), result = pageEvidence(url.href, raw, text(args.query, 200));
        await this.snapshot(result.snapshot, "page.html", raw); await this.snapshot(result.snapshot, "extracted.txt", result.extracted);
        return { status: "success", structuredContent: json({ evidence: result.evidence }) };
      }),
      tool("retrieval_publish_local", ["write"], async (args, context) => {
        context.signal?.throwIfAborted(); const report = object(args.report) as unknown as Report;
        if (report.requestId !== this.request.id || !Array.isArray(report.findings)) throw new Error("Report identity mismatch");
        const directory = join(this.directory, "artifacts"); await mkdir(directory, { recursive: true });
        const lines = [`# Evidence brief`, "", report.question, "", `Result: ${report.status}`, `Queries: ${report.queries.join("; ")}`, ""];
        for (const finding of report.findings) { const e = report.evidence.find(e => e.id === finding.sourceId); if (!e || !e.text.includes(finding.quote)) throw new Error("Invalid publication citation");
          lines.push(`> ${finding.quote}`, "", `Source: ${e.title} — ${e.uri}`, `Location: ${e.location}`, `Snapshot: ${e.snapshot}`, "");
        }
        for (const failure of report.failures) lines.push(`Unavailable source: ${failure.source} (${failure.code})`);
        await immutable(join(directory, "brief.json"), JSON.stringify(report, null, 2) + "\n");
        await immutable(join(directory, "brief.md"), lines.join("\n") + "\n");
        return { status: "success", structuredContent: json({ files: ["artifacts/brief.json", "artifacts/brief.md"] }) };
      }),
    ];
  }
  close() { this.db?.close(); }
}
