import { mkdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import { immutable } from "../execution/files.ts";
import { digest, json, object } from "../evidence.ts";
import {
  request,
  catalog,
  candidate,
  candidateId,
  check,
  assessment,
  eligible,
  score,
  normalized,
  hash,
  fusion,
  combine,
  type Request,
  type Catalog,
  type Candidate,
  type Grade,
  type Report,
} from "./domain.ts";
async function regular(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 500000)
    throw new Error("Invalid application file");
  return readFile(path, "utf8");
}
export async function createTask(
  directory: string,
  input: Omit<Request, "sourceDigest">,
  source: Catalog,
) {
  const s = catalog(source),
    raw = JSON.stringify(s),
    r = request({ ...input, sourceDigest: digest(raw) });
  await mkdir(directory, { recursive: true });
  await immutable(join(directory, "product.json"), raw);
  await immutable(join(directory, "request.json"), JSON.stringify(r, null, 2));
  await immutable(
    join(directory, "policy.json"),
    JSON.stringify({
      fingerprint: digest(JSON.stringify(r)),
      enabled: true,
      principals: [r.principal],
    }),
  );
  return r;
}
export async function createDemo(
  directory: string,
  overrides: Partial<Omit<Request, "sourceDigest">> = {},
  missing = false,
) {
  return createTask(
    directory,
    {
      id: randomUUID(),
      tenant: "demo",
      principal: "editor",
      goal: "为 Orbit 笔记工具创作简洁可信的中文产品文案，面向需要整理工作资料的小团队。",
      mode: "select",
      allowFallback: true,
      count: 3,
      minScore: 18,
      maxModelCalls: 10,
      deadlineSeconds: 600,
      ...overrides,
    },
    {
      product: "Orbit",
      cta: "了解产品",
      facts: missing
        ? []
        : [
            { id: "offline", text: "支持离线编辑" },
            { id: "export", text: "可导出 Markdown" },
            { id: "team", text: "团队版支持共享工作区" },
          ],
    },
  );
}
export class CandidateAdapters {
  readonly directory: string;
  readonly request: Request;
  constructor(directory: string, r: Request) {
    this.directory = directory;
    this.request = request(r);
  }
  async authorize() {
    const r = request(
        JSON.parse(await regular(join(this.directory, "request.json"))),
      ),
      p = object(
        JSON.parse(await regular(join(this.directory, "policy.json"))),
      );
    if (
      JSON.stringify(r) !== JSON.stringify(this.request) ||
      p.fingerprint !== digest(JSON.stringify(r))
    )
      throw new Error("Task request changed");
    if (
      p.enabled !== true ||
      !Array.isArray(p.principals) ||
      !p.principals.includes(r.principal)
    )
      throw new Error("Task permission revoked");
  }
  async load() {
    const raw = await regular(join(this.directory, "product.json"));
    if (digest(raw) !== this.request.sourceDigest)
      throw new Error("Source changed");
    return catalog(JSON.parse(raw));
  }
  async loadCandidate(id: string) {
    const raw = await regular(
        join(this.directory, "candidates", hash(id) + ".json"),
      ),
      c = candidate(JSON.parse(raw));
    if (digest(raw) !== id || candidateId(c) !== id)
      throw new Error("Candidate checksum mismatch");
    return c;
  }
  async put(c: Candidate) {
    const id = candidateId(c);
    await mkdir(join(this.directory, "candidates"), { recursive: true });
    await immutable(
      join(this.directory, "candidates", id + ".json"),
      JSON.stringify(c),
    );
    return id;
  }
  async loadGrade(id: string): Promise<Grade> {
    const raw = await regular(
      join(this.directory, "grades", hash(id) + ".json"),
    );
    if (digest(raw) !== id) throw new Error("Grade checksum mismatch");
    const g = JSON.parse(raw) as Grade,
      c = await this.loadCandidate(g.candidateId),
      s = await this.load();
    if (
      g.sourceDigest !== this.request.sourceDigest ||
      JSON.stringify(check(c, s)) !== JSON.stringify(g.issues)
    )
      throw new Error("Grade source mismatch");
    if (g.assessment) assessment(g.assessment, g.candidateId);
    return g;
  }
  async validateReport(input: unknown) {
    const out = input as Report,
      r = this.request;
    if (
      out.requestId !== r.id ||
      !["completed", "partial", "needs-human"].includes(out.status) ||
      !Array.isArray(out.entries)
    )
      throw new Error("Invalid report");
    const ranked: Report["ranking"] = [],
      seen = new Set<string>();
    for (const e of out.entries) {
      if (!e.candidateId) continue;
      const c = await this.loadCandidate(e.candidateId),
        n = normalized(c);
      if (seen.has(n)) {
        if (e.error !== "duplicate") throw new Error("Duplicate admission");
        continue;
      }
      seen.add(n);
      if (e.gradeId) {
        const g = await this.loadGrade(e.gradeId);
        if (g.candidateId !== e.candidateId)
          throw new Error("Grade identity mismatch");
        if (eligible(g, r))
          ranked.push({
            candidateId: e.candidateId,
            gradeId: e.gradeId,
            score: score(g.assessment!),
          });
      }
    }
    ranked.sort(
      (a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId),
    );
    if (JSON.stringify(ranked) !== JSON.stringify(out.ranking))
      throw new Error("Ranking changed");
    if (out.status === "completed") {
      if (!ranked.length || !out.finalId)
        throw new Error("Missing qualified final result");
      const final = await this.loadCandidate(out.finalId);
      if (out.applied === "fuse") {
        if (r.mode !== "fuse" || !out.fusion || !out.fusionGradeId)
          throw new Error("Invalid fusion publication");
        const ids = ranked.slice(0, 2).map((x) => x.candidateId),
          f = fusion(out.fusion, ids),
          parents = new Map<string, Candidate>();
        for (const id of ids) parents.set(id, await this.loadCandidate(id));
        if (JSON.stringify(combine(f, parents)) !== JSON.stringify(final))
          throw new Error("Fusion lineage mismatch");
        const g = await this.loadGrade(out.fusionGradeId);
        if (g.candidateId !== out.finalId || !eligible(g, r))
          throw new Error("Unverified fused candidate");
      } else if (
        out.finalId !== ranked[0]!.candidateId ||
        !(
          (out.applied === "select" && r.mode === "select") ||
          (out.applied === "fallback" &&
            r.mode === "fuse" &&
            r.allowFallback &&
            out.fusionError)
        )
      )
        throw new Error("Unqualified selection");
    } else if (out.finalId !== null || out.applied !== null)
      throw new Error("Unverified final output");
    return out;
  }
  get tools(): RegisteredTool[] {
    const tool = (
      name: string,
      effects: RegisteredTool["effects"],
      run: RegisteredTool["execute"],
    ): RegisteredTool => ({
      name,
      effects: effects ?? [],
      inputSchema: { type: "object" },
      validate: object,
      execute: async (a, c) => {
        await this.authorize();
        c.signal?.throwIfAborted();
        return run(a, c);
      },
    });
    return [
      tool("candidates_load", ["read"], async () => ({
        status: "success",
        structuredContent: json(await this.load()),
      })),
      tool("candidates_save", ["read", "write"], async (a) => {
        const c = candidate(a.candidate),
          id = await this.put(c);
        return {
          status: "success",
          structuredContent: json({
            candidateId: id,
            issues: check(c, await this.load()),
          }),
        };
      }),
      tool("candidates_grade", ["read", "write"], async (a) => {
        const id = hash(a.candidateId),
          c = await this.loadCandidate(id),
          s = await this.load(),
          g: Grade = {
            candidateId: id,
            sourceDigest: this.request.sourceDigest,
            issues: check(c, s),
            assessment:
              a.assessment === null ? null : assessment(a.assessment, id),
          },
          raw = JSON.stringify(g),
          gradeId = digest(raw);
        await mkdir(join(this.directory, "grades"), { recursive: true });
        await immutable(join(this.directory, "grades", gradeId + ".json"), raw);
        return {
          status: "success",
          structuredContent: json({ gradeId, grade: g }),
        };
      }),
      tool("candidates_publish", ["read", "write"], async (a) => {
        await this.load();
        const out = await this.validateReport(a.report),
          dir = join(this.directory, "output");
        await mkdir(dir, { recursive: true });
        await immutable(
          join(dir, "report.json"),
          JSON.stringify(out, null, 2) + "\n",
        );
        const esc = (s: string) => s.replace(/[\\`*_\[\]<>#]/g, "\\$&");
        let body = `# Candidate selection\n\nStatus: ${out.status}\nStop: ${out.stopReason}\nMethod: ${out.applied ?? "none"}\n\n`;
        if (out.finalId) {
          const c = await this.loadCandidate(out.finalId);
          await immutable(
            join(dir, "copy.json"),
            JSON.stringify(c, null, 2) + "\n",
          );
          const copy = `# ${esc(c.headline)}\n\n${esc(c.body)}\n\n${esc(c.cta)}\n`;
          await immutable(join(dir, "copy.md"), copy);
          body += copy + "\n";
        }
        body +=
          "## Ranking\n\n| Candidate | Score / 25 |\n| --- | ---: |\n" +
          out.ranking
            .map((x) => `| ${x.candidateId} | ${x.score} |`)
            .join("\n") +
          "\n\n## Candidate outcomes\n\n" +
          out.entries
            .map(
              (e) =>
                `- ${e.angle}: ${e.error ?? (e.gradeId ? "evaluated" : "not evaluated")}; ${e.candidateId ?? "no valid candidate"}`,
            )
            .join("\n") +
          "\n";
        if (out.fusion)
          body +=
            "\n## Fusion lineage\n\n" + esc(JSON.stringify(out.fusion)) + "\n";
        if (out.fusionError) body += "\nFusion: " + esc(out.fusionError) + "\n";
        await immutable(join(dir, "report.md"), body);
        return { status: "success", structuredContent: { published: true } };
      }),
    ];
  }
}
