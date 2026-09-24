import { DatabaseSync } from "node:sqlite";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import {
  createTextSearchProvider,
  RetrievalTargetRegistry,
} from "@ditto/core/worker/retrieval";
import type { RegisteredTool } from "@ditto/core/worker/interaction";
import { immutable } from "../execution/files.ts";
import {
  answer,
  chunks,
  digest,
  json,
  object,
  request,
  sources,
  text,
  tokens,
  type Chunk,
  type Request,
  type Report,
  type Source,
} from "./domain.ts";
export class RagAdapters {
  readonly directory: string;
  readonly request: Request;
  readonly db: DatabaseSync;
  constructor(directory: string, input: Request) {
    this.directory = directory;
    this.request = request(input);
    this.db = new DatabaseSync(join(directory, "corpus.sqlite"));
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, source_id TEXT NOT NULL, payload TEXT NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED, terms)",
    );
  }
  async authorized(): Promise<Source[]> {
    const catalog = sources(
      JSON.parse(await readFile(join(this.directory, "sources.json"), "utf8")),
    );
    return this.request.sourceIds.map((id) => {
      const s = catalog.find((s) => s.id === id);
      if (
        !s ||
        s.tenant !== this.request.tenant ||
        !s.readers.includes(this.request.principal)
      )
        throw new Error("Source access denied");
      return s;
    });
  }
  private async snapshot(raw: string) {
    const dir = join(this.directory, "snapshots");
    await mkdir(dir, { recursive: true });
    await immutable(join(dir, `${digest(raw)}.txt`), raw);
  }
  private async ingest(memories: unknown): Promise<Chunk[]> {
    const catalog = await this.authorized(),
      records = object(memories),
      result: Chunk[] = [];
    for (const source of catalog) {
      let raw: string;
      if (source.kind === "document") {
        const root = await realpath(this.directory),
          path = await realpath(join(root, source.ref)),
          rest = relative(root, path),
          stat = await lstat(path);
        if (
          isAbsolute(rest) ||
          rest === ".." ||
          rest.startsWith("../") ||
          !stat.isFile() ||
          stat.size > 400_000
        )
          throw new Error("Document outside task directory or too large");
        raw = await readFile(path, "utf8");
      } else if (source.kind === "external") {
        const external = new DatabaseSync(
          join(this.directory, "knowledge.sqlite"),
          { readOnly: true },
        );
        try {
          const row = external
            .prepare("SELECT title, body FROM articles WHERE tenant=? AND id=?")
            .get(this.request.tenant, source.ref);
          if (!row || row.title !== source.title)
            throw new Error("External knowledge unavailable or title mismatch");
          raw = text(row.body, 100_000);
        } finally {
          external.close();
        }
      } else {
        const memory = object(records[source.ref]),
          content = object(memory.content);
        if (
          memory.key !== source.ref ||
          content.kind !== "knowledge" ||
          content.tenant !== this.request.tenant ||
          content.title !== source.title
        )
          throw new Error("Invalid approved internal knowledge");
        raw = text(content.text, 100_000);
      }
      await this.snapshot(raw);
      result.push(...chunks(source, raw));
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM chunks; DELETE FROM search");
      const put = this.db.prepare("INSERT INTO chunks VALUES(?,?,?)"),
        index = this.db.prepare("INSERT INTO search VALUES(?,?)");
      for (const chunk of result) {
        put.run(chunk.id, chunk.sourceId, JSON.stringify(chunk));
        index.run(chunk.id, tokens(chunk.title + " " + chunk.text).join(" "));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return result;
  }
  async validateEvidence(evidence: Chunk[]) {
    const catalog = await this.authorized();
    for (const chunk of evidence) {
      const source = catalog.find((s) => s.id === chunk.sourceId);
      if (
        !source ||
        source.title !== chunk.title ||
        source.kind !== chunk.kind ||
        `${source.kind}:${source.ref}` !== chunk.uri ||
        !/^[a-f0-9]{64}$/.test(chunk.snapshot)
      )
        throw new Error("Source identity changed; start a new task");
      const raw = await readFile(
        join(this.directory, "snapshots", `${chunk.snapshot}.txt`),
        "utf8",
      );
      if (
        digest(raw) !== chunk.snapshot ||
        !chunks(source, raw).some(
          (c) => JSON.stringify(c) === JSON.stringify(chunk),
        )
      )
        throw new Error("Source snapshot integrity failed");
    }
  }
  get providers() {
    return new RetrievalTargetRegistry({
      "rag-corpus": {
        defaultStrategy: "bm25",
        providers: {
          bm25: createTextSearchProvider({
            search: async (input, context) => {
              context?.signal?.throwIfAborted();
              await this.authorized();
              if (
                input.target.namespace !==
                `${this.request.tenant}:${this.request.principal}:${this.request.id}`
              )
                throw new Error("Retrieval namespace denied");
              const terms = tokens(text(input.query.content, 120)).slice(0, 32);
              if (!terms.length) throw new Error("Empty search terms");
              const rows = this.db
                .prepare(
                  "SELECT c.payload, bm25(search) AS rank FROM search JOIN chunks c ON c.id=search.id WHERE search MATCH ? ORDER BY rank, c.id LIMIT ?",
                )
                .all(
                  terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR "),
                  input.limit ?? 12,
                );
              const values = rows.map(
                (r) => JSON.parse(String(r.payload)) as Chunk,
              );
              await this.validateEvidence(values);
              return {
                target: input.target,
                candidates: values.map((c, i) => ({
                  id: c.id,
                  content: c.text,
                  score: -Number(rows[i]!.rank),
                  source: { target: input.target.name, ref: c.uri },
                  metadata: { chunk: json(c) },
                })),
              };
            },
          }),
        },
      },
    });
  }
  get tools(): RegisteredTool[] {
    const tool = (
      name: string,
      effects: ("read" | "write")[],
      execute: RegisteredTool["execute"],
    ): RegisteredTool => ({
      name,
      effects,
      inputSchema: { type: "object" },
      validate: object,
      execute,
    });
    return [
      tool("rag_authorize", ["read"], async (args, ctx) => {
        ctx.signal?.throwIfAborted();
        if (
          JSON.stringify(request(args.request)) !== JSON.stringify(this.request)
        )
          throw new Error("Runtime request binding mismatch");
        return {
          status: "success",
          structuredContent: json({ sources: await this.authorized() }),
        };
      }),
      tool("rag_ingest", ["read", "write"], async (args, ctx) => {
        ctx.signal?.throwIfAborted();
        return {
          status: "success",
          structuredContent: json({ chunks: await this.ingest(args.memories) }),
        };
      }),
      tool("rag_check_sources", ["read"], async (args, ctx) => {
        ctx.signal?.throwIfAborted();
        if (!Array.isArray(args.evidence)) throw new Error("Invalid evidence");
        await this.validateEvidence(args.evidence as unknown as Chunk[]);
        if (args.verifyIndex === true) {
          const expected = (args.evidence as unknown as Chunk[])
            .slice()
            .sort((a, b) => a.id.localeCompare(b.id));
          const stored = this.db
            .prepare("SELECT payload FROM chunks ORDER BY id")
            .all()
            .map((row) => JSON.parse(String(row.payload)));
          const indexed = this.db
            .prepare("SELECT id, terms FROM search ORDER BY id")
            .all();
          if (
            JSON.stringify(stored) !== JSON.stringify(expected) ||
            JSON.stringify(indexed) !==
              JSON.stringify(
                expected.map((c) => ({
                  id: c.id,
                  terms: tokens(c.title + " " + c.text).join(" "),
                })),
              )
          )
            throw new Error("Retrieval index integrity failed");
        }
        return { status: "success", structuredContent: { valid: true } };
      }),
      tool("rag_publish", ["read", "write"], async (args, ctx) => {
        ctx.signal?.throwIfAborted();
        const report = object(args.report) as unknown as Report;
        if (
          report.requestId !== this.request.id ||
          report.question !== this.request.question
        )
          throw new Error("Report request mismatch");
        await this.validateEvidence(report.evidence);
        answer(report.answer, report.evidence, report.selection);
        const escape = (s: string) =>
          s
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replace(/([\\`*_{}\[\]()#+!|])/g, "\\$1");
        const lines = [
          "# RAG answer",
          "",
          escape(report.question),
          "",
          `Status: ${report.answer.status}`,
          "",
        ];
        for (const claim of report.answer.claims) {
          lines.push(
            escape(claim.text) +
              " " +
              claim.citations.map((c) => `[${c.chunkId}]`).join(" "),
            "",
          );
        }
        for (const limitation of report.answer.limitations)
          lines.push(`- ${escape(limitation)}`);
        lines.push("", "## Sources", "");
        for (const claim of report.answer.claims)
          for (const cite of claim.citations) {
            const chunk = report.evidence.find((c) => c.id === cite.chunkId)!;
            lines.push(
              `### ${cite.chunkId}`,
              "",
              `${escape(chunk.title)} (${chunk.kind}) — ${escape(chunk.uri)}`,
              `Lines ${chunk.startLine}–${chunk.endLine}; SHA-256: ${chunk.snapshot}`,
              "",
              ...cite.quote.split("\n").map((s) => `> ${escape(s)}`),
              "",
            );
          }
        const dir = join(this.directory, "artifacts");
        await mkdir(dir, { recursive: true });
        await immutable(
          join(dir, "answer.json"),
          JSON.stringify(report, null, 2) + "\n",
        );
        await immutable(join(dir, "answer.md"), lines.join("\n") + "\n");
        return {
          status: "success",
          structuredContent: {
            files: ["artifacts/answer.json", "artifacts/answer.md"],
          },
        };
      }),
    ];
  }
  close() {
    this.db.close();
  }
}
