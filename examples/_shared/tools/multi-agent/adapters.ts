import { mkdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RegisteredTool } from "@ditto/core/worker/interaction";
import { immutable } from "../execution/files.ts";
import { digest, json, object } from "../evidence.ts";
import {
  request,
  sources,
  evidence,
  finding,
  resultId,
  summary,
  plan,
  hash,
  specialists,
  type Request,
  type Sources,
  type Saved,
  type Report,
  type Handoff,
  type Specialist,
} from "./domain.ts";
async function file(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 1000000)
    throw new Error("Invalid task file");
  return readFile(path, "utf8");
}
export async function createDemo(
  directory: string,
  options: Partial<Omit<Request, "sourceDigest">> = {},
  ready = false,
) {
  await mkdir(directory, { recursive: true });
  const source: Sources = {
      releaseId: "REL-204",
      engineering: { total: 50, passed: ready ? 50 : 48, criticalOpen: 0 },
      operations: { rollbackVerified: true, oncallAssigned: true },
    },
    r = request({
      id: randomUUID(),
      tenant: "demo",
      principal: "operator",
      goal: "评估版本是否具备发布条件，分别分析工程质量和运维准备情况，汇总依据与未解决事项。",
      mode: "parallel",
      maxModelCalls: 7,
      maxAgentAttempts: 2,
      deadlineSeconds: 600,
      ...options,
      sourceDigest: digest(JSON.stringify(source)),
    });
  await immutable(join(directory, "sources.json"), JSON.stringify(source));
  await immutable(join(directory, "request.json"), JSON.stringify(r, null, 2));
  await immutable(
    join(directory, "policy.json"),
    JSON.stringify({ enabled: true, principals: [r.principal] }),
  );
  return r;
}
export class TeamAdapters {
  readonly directory: string;
  readonly request: Request;
  constructor(directory: string, r: Request) {
    this.directory = directory;
    this.request = request(r);
  }
  async authorize() {
    const r = request(
        JSON.parse(await file(join(this.directory, "request.json"))),
      ),
      p = object(JSON.parse(await file(join(this.directory, "policy.json"))));
    if (JSON.stringify(r) !== JSON.stringify(this.request))
      throw new Error("Task request changed");
    if (
      p.enabled !== true ||
      !Array.isArray(p.principals) ||
      !p.principals.includes(r.principal)
    )
      throw new Error("Permission revoked");
  }
  async load() {
    await this.authorize();
    const s = sources(
      JSON.parse(await file(join(this.directory, "sources.json"))),
    );
    if (digest(JSON.stringify(s)) !== this.request.sourceDigest)
      throw new Error("Source changed");
    return s;
  }
  async result(id: string): Promise<Saved> {
    hash(id);
    const raw = await file(join(this.directory, "results", id + ".json")),
      saved = JSON.parse(raw) as Saved;
    if (
      digest(raw) !== id ||
      saved.requestDigest !== digest(JSON.stringify(this.request))
    )
      throw new Error("Result checksum or task mismatch");
    const source = await this.load();
    if (!specialists.includes(saved.finding.agent))
      throw new Error("Unknown specialist");
    finding(saved.finding, evidence(source, saved.finding.agent));
    return saved;
  }
  get tools(): RegisteredTool[] {
    const tool = (
      name: string,
      run: RegisteredTool["execute"],
    ): RegisteredTool => ({
      name,
      effects: ["read", "write"],
      inputSchema: { type: "object" },
      validate: object,
      execute: async (a, c) => {
        await this.authorize();
        c.signal?.throwIfAborted();
        return run(a, c);
      },
    });
    return [
      tool("team_authorize", async () => {
        await this.load();
        return { status: "success", structuredContent: { authorized: true } };
      }),
      ...specialists.map((agent) =>
        tool(`team_read_${agent}`, async (a) => {
          if (Object.keys(a).length)
            throw new Error("Specialist tools have fixed source scopes");
          return {
            status: "success",
            structuredContent: json(evidence(await this.load(), agent)),
          };
        }),
      ),
      tool("team_save", async (a) => {
        const agent = String(a.agent) as Specialist;
        if (!specialists.includes(agent)) throw new Error("Unknown specialist");
        const source = await this.load();
        let f;
        try {
          f = finding(a.finding, evidence(source, agent));
        } catch {
          return {
            status: "failed",
            error: {
              code: "INVALID_FINDING",
              message: "Specialist output failed evidence validation",
            },
          };
        }
        const dependencies = Array.isArray(a.dependencies)
          ? a.dependencies.map(hash)
          : [];
        if (agent === "operations" && this.request.mode === "serial") {
          if (
            dependencies.length !== 1 ||
            (await this.result(dependencies[0]!)).finding.agent !==
              "engineering"
          )
            throw new Error("Missing engineering handoff");
        } else if (dependencies.length) throw new Error("Unexpected handoff");
        const saved: Saved = {
            requestDigest: digest(JSON.stringify(this.request)),
            finding: f,
            dependencies,
          },
          id = resultId(saved);
        await mkdir(join(this.directory, "results"), { recursive: true });
        await immutable(
          join(this.directory, "results", id + ".json"),
          JSON.stringify(saved),
        );
        return { status: "success", structuredContent: { resultId: id } };
      }),
      tool("team_result", async (a) => ({
        status: "success",
        structuredContent: json(await this.result(hash(a.id))),
      })),
      tool("team_publish", async (a) => {
        const out = a.report as unknown as Report;
        if (
          out.requestId !== this.request.id ||
          !["completed", "partial", "needs-human"].includes(out.status)
        )
          throw new Error("Invalid report");
        await this.load();
        if (out.plan) plan(out.plan, this.request);
        const results: Handoff[] = [];
        for (const entry of out.entries) {
          if (entry.resultId) {
            const saved = await this.result(entry.resultId);
            if (
              saved.finding.agent !== entry.agent ||
              entry.status !== "completed"
            )
              throw new Error("Agent result mismatch");
            if (
              entry.agent === "operations" &&
              this.request.mode === "serial" &&
              saved.dependencies[0] !==
                out.entries.find((x) => x.agent === "engineering")?.resultId
            )
              throw new Error("Handoff changed");
            results.push({ resultId: entry.resultId, finding: saved.finding });
          } else if (entry.status === "completed")
            throw new Error("Missing result");
        }
        if (
          new Set(out.entries.map((x) => x.agent)).size !== out.entries.length
        )
          throw new Error("Duplicate entry");
        if (out.summary) summary(out.summary, results);
        if (
          out.status === "completed" &&
          (!out.plan || results.length !== 2 || !out.summary)
        )
          throw new Error("Incomplete team task");
        const dir = join(this.directory, "output");
        await mkdir(dir, { recursive: true });
        await immutable(
          join(dir, "report.json"),
          JSON.stringify(out, null, 2) + "\n",
        );
        const md =
          `# ${out.summary?.title ?? "Release readiness review"}\n\nTask status: ${out.status}\nStop: ${out.stopReason}\nReadiness: ${out.summary?.verdict ?? "not assessed"}\n\n${out.summary?.summary ?? "No synthesized conclusion is available."}\n\n` +
          out.entries
            .map(
              (e) =>
                `## ${e.agent}\n\nStatus: ${e.status}\nAttempts: ${e.attempts}\nErrors: ${e.errors.join(", ") || "none"}\n\n` +
                (results
                  .find((x) => x.finding.agent === e.agent)
                  ?.finding.citations.map((c) => `- ${c.id}: ${c.quote}`)
                  .join("\n") ?? "No verified result") +
                "\n",
            )
            .join("\n");
        await immutable(join(dir, "report.md"), md);
        return { status: "success", structuredContent: { published: true } };
      }),
    ];
  }
}
