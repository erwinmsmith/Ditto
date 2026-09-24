import { mkdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import { immutable } from "../execution/files.ts";
import { digest, json, object } from "../evidence.ts";
import {
  request,
  sources,
  evidence,
  view,
  comparison,
  synthesis,
  hash,
  idOf,
  roles,
  type Request,
  type Sources,
  type Perspective,
  type SavedView,
  type Handoff,
  type Report,
} from "./domain.ts";
async function file(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 1000000)
    throw new Error("Invalid task file");
  return readFile(path, "utf8");
}
export type Scenario = "tradeoffs" | "aligned" | "missing-cost" | "unsafe";
export async function createDemo(
  directory: string,
  overrides: Partial<Omit<Request, "sourceDigest">> = {},
  scenario: Scenario = "tradeoffs",
) {
  if (!["tradeoffs", "aligned", "missing-cost", "unsafe"].includes(scenario))
    throw new Error("Invalid scenario");
  await mkdir(directory, { recursive: true });
  const s: Sources = {
    proposalId: "PILOT-204",
    upliftPercent: scenario === "aligned" ? 10 : 8,
    forecastRevenueCents: 1500000,
    pilotCostCents:
      scenario === "missing-cost"
        ? null
        : scenario === "aligned"
          ? 800000
          : 1200000,
    errorBps: scenario === "unsafe" ? 200 : scenario === "aligned" ? 5 : 40,
    rollbackVerified: scenario !== "unsafe",
    oncallAssigned: scenario === "aligned",
  };
  const r = request({
    id: randomUUID(),
    tenant: "demo",
    principal: "operator",
    question:
      "是否扩大产品试点？请分别从产品价值、财务约束与运行可靠性角度独立分析同一份事实，保留分歧，形成有条件的综合建议。",
    maxModelCalls: 12,
    maxAttempts: 2,
    deadlineSeconds: 600,
    ...overrides,
    sourceDigest: idOf(s),
  });
  await immutable(join(directory, "sources.json"), JSON.stringify(s));
  await immutable(join(directory, "request.json"), JSON.stringify(r, null, 2));
  await immutable(
    join(directory, "policy.json"),
    JSON.stringify({ enabled: true, principals: [r.principal] }),
  );
  return r;
}
export class DebateAdapters {
  readonly directory: string;
  readonly request: Request;
  constructor(directory: string, r: Request) {
    this.directory = directory;
    this.request = request(r);
  }
  async load() {
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
    const s = sources(
      JSON.parse(await file(join(this.directory, "sources.json"))),
    );
    if (idOf(s) !== r.sourceDigest) throw new Error("Source changed");
    return s;
  }
  async result(id: string): Promise<SavedView> {
    hash(id);
    const raw = await file(join(this.directory, "views", id + ".json")),
      saved = JSON.parse(raw) as SavedView;
    if (
      digest(raw) !== id ||
      saved.requestDigest !== idOf(this.request) ||
      !roles.includes(saved.view.agent)
    )
      throw new Error("View checksum or task mismatch");
    view(saved.view, evidence(await this.load(), saved.view.agent));
    return saved;
  }
  async verify(out: Report) {
    const s = await this.load();
    if (
      out.requestId !== this.request.id ||
      out.entries.length !== 3 ||
      new Set(out.entries.map((e) => e.agent)).size !== 3 ||
      out.entries.some((e) => !roles.includes(e.agent))
    )
      throw new Error("Invalid report identity");
    const views: Handoff[] = [];
    for (const e of out.entries)
      if (e.resultId) {
        const saved = await this.result(e.resultId);
        if (saved.view.agent !== e.agent) throw new Error("View role changed");
        views.push({ id: e.resultId, view: saved.view });
      }
    if (out.comparison) comparison(out.comparison, views);
    if (out.synthesis) {
      if (!out.comparison) throw new Error("Missing comparison");
      synthesis(out.synthesis, out.comparison, s);
    }
    if (
      out.status === "completed" &&
      (views.length !== 3 || !out.comparison || !out.synthesis)
    )
      throw new Error("Incomplete discussion cannot be completed");
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
        c.signal?.throwIfAborted();
        await this.load();
        return run(a, c);
      },
    });
    const ok = (v: unknown) => ({
      status: "success" as const,
      structuredContent: json(v),
    });
    return [
      tool("debate_authorize", async () => ok({ authorized: true })),
      ...roles.map((agent) =>
        tool(`debate_read_${agent}`, async (a) => {
          if (Object.keys(a).length)
            throw new Error("Fixed discussion scope required");
          const s = await this.load(),
            e = evidence(s, agent);
          return ok({ agent, source: s, criteria: e.criteria, facts: e.facts });
        }),
      ),
      tool("debate_save", async (a) => {
        const agent = String(a.agent) as Perspective;
        if (!roles.includes(agent)) throw new Error("Unknown perspective");
        const source = await this.load();
        let v;
        try {
          v = view(a.view, evidence(source, agent));
        } catch {
          return {
            status: "failed",
            error: {
              code: "INVALID_VIEW",
              message: "View violates identity, evidence or disclosed criteria",
            },
          };
        }
        const saved: SavedView = { requestDigest: idOf(this.request), view: v },
          id = idOf(saved);
        await mkdir(join(this.directory, "views"), { recursive: true });
        await immutable(
          join(this.directory, "views", id + ".json"),
          JSON.stringify(saved),
        );
        return ok({ id });
      }),
      tool("debate_result", async (a) => ok(await this.result(hash(a.id)))),
      tool("debate_materials", async (a) => {
        if (
          !Array.isArray(a.ids) ||
          !a.ids.length ||
          a.ids.length > 3 ||
          new Set(a.ids).size !== a.ids.length
        )
          throw new Error("Invalid opinion IDs");
        const views: Handoff[] = [];
        for (const id of a.ids) {
          const s = await this.result(hash(id));
          views.push({ id: String(id), view: s.view });
        }
        if (new Set(views.map((v) => v.view.agent)).size !== views.length)
          throw new Error("Duplicate perspective");
        return ok({ source: await this.load(), views });
      }),
      tool("debate_publish", async (a) => {
        const out = a.report as unknown as Report;
        await this.verify(out);
        const dir = join(this.directory, "output");
        await mkdir(dir, { recursive: true });
        await immutable(
          join(dir, "report.json"),
          JSON.stringify(out, null, 2) + "\n",
        );
        const rows = ["topic,kind,positive,concern,unknown"];
        for (const t of out.comparison?.matrix.topics ?? [])
          rows.push(
            [
              t.topic,
              t.kind,
              ...(["positive", "concern", "unknown"] as const).map(
                (j) =>
                  t.groups.find((g) => g.judgment === j)?.agents.join("|") ??
                  "",
              ),
            ].join(","),
          );
        await immutable(join(dir, "comparison.csv"), rows.join("\n") + "\n");
        let md = `# Multi-perspective discussion\n\nStatus: ${out.status}\nStop: ${out.stopReason}\nRecommendation: ${out.synthesis?.recommendation ?? "not synthesized"}\n\n${out.synthesis?.summary ?? "No final synthesis is available."}\n\n`;
        md += `Missing perspectives: ${
          out.comparison?.matrix.missingAgents.join(", ") ||
          out.entries
            .filter((e) => !e.resultId)
            .map((e) => e.agent)
            .join(", ") ||
          "none"
        }\n\n`;
        for (const t of out.comparison?.topics ?? []) {
          const row = out.comparison!.matrix.topics.find(
            (r) => r.topic === t.topic,
          )!;
          md +=
            `## ${t.topic}: ${t.kind}\n\n${t.summary}\n\n` +
            row.groups
              .map((g) => `- ${g.judgment}: ${g.agents.join(", ")}`)
              .join("\n") +
            "\n\n";
        }
        for (const c of out.synthesis?.conditions ?? [])
          md += `- Follow-up (${c.topic}): ${c.action}\n`;
        for (const entry of out.entries) {
          md += `\n## Independent view: ${entry.agent}\n\nAttempts: ${entry.attempts}\nErrors: ${entry.errors.join(", ") || "none"}\n\n`;
          if (entry.resultId) {
            const { view: v } = await this.result(entry.resultId);
            md += `Position: ${v.position}\n\n${v.summary}\n\nTrade-off: ${v.tradeoff}\n\n`;
            for (const a of v.assessments)
              md +=
                `### ${a.topic}: ${a.judgment}\n\n${a.reason}\n\n` +
                a.citations.map((c) => `- ${c.id}: ${c.quote}`).join("\n") +
                "\n\n";
          } else md += "No verified opinion was obtained.\n";
        }
        await immutable(join(dir, "report.md"), md);
        return ok({ published: true });
      }),
    ];
  }
}
