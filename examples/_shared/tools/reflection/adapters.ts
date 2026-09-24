import { mkdir, readFile, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import { immutable } from "../execution/files.ts";
import { digest, json, object } from "../evidence.ts";
import {
  request,
  sources,
  draft,
  draftId,
  review,
  check,
  hash,
  type Request,
  type Report,
  type Draft,
} from "./domain.ts";
export type Scenario = "generate" | "flawed-draft" | "missing-data";
async function regular(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 500000)
    throw new Error("Invalid application file");
  return readFile(path, "utf8");
}
export const flawedDraft: Draft = {
  title: "Monthly sales analysis",
  metrics: {
    baselineNetCents: 120000,
    currentNetCents: 150000,
    growthPercent: 50,
  },
  interpretation:
    "Sales grew because the campaign succeeded. This proves the campaign will keep driving growth.",
  limitations: [],
  actions: [],
  citations: [],
};
export async function createDemo(
  directory: string,
  scenario: Scenario = "generate",
  overrides: Partial<Request> = {},
) {
  if (!["generate", "flawed-draft", "missing-data"].includes(scenario))
    throw new Error("Invalid scenario");
  const csv =
      "month,grossCents,refundCents\n2026-07,120000,6000\n" +
      (scenario === "missing-data" ? "" : "2026-08,150000,9000\n"),
    seed = scenario === "flawed-draft" ? JSON.stringify(flawedDraft) : null;
  const r = request({
    id: randomUUID(),
    tenant: "demo",
    principal: "analyst",
    goal: "生成月度经营分析：比较两个月的净收入、增长率，说明解释边界，并提出有负责角色的后续建议，引用原始数据。",
    sourceDigest: digest(csv),
    seedDigest: seed ? digest(seed) : null,
    maxRounds: 4,
    maxModelCalls: 8,
    deadlineSeconds: 600,
    ...overrides,
  });
  await mkdir(directory, { recursive: true });
  await immutable(join(directory, "sales.csv"), csv);
  if (seed) await immutable(join(directory, "seed.json"), seed);
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
export class ReflectionAdapters {
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
    const raw = await regular(join(this.directory, "sales.csv"));
    if (digest(raw) !== this.request.sourceDigest)
      throw new Error("Source changed; create a new task for revised data");
    return sources(raw);
  }
  async loadDraft(id: string) {
    const d = draft(
      JSON.parse(
        await regular(join(this.directory, "drafts", hash(id) + ".json")),
      ),
    );
    if (draftId(d) !== id) throw new Error("Draft checksum mismatch");
    return d;
  }
  async putDraft(input: unknown) {
    const d = draft(input),
      id = draftId(d);
    await mkdir(join(this.directory, "drafts"), { recursive: true });
    await immutable(
      join(this.directory, "drafts", id + ".json"),
      JSON.stringify(d),
    );
    return { draftId: id, draft: d };
  }
  async proof(id: string) {
    const raw = await regular(
      join(this.directory, "checks", hash(id) + ".json"),
    );
    if (digest(raw) !== id) throw new Error("Check checksum mismatch");
    return object(JSON.parse(raw));
  }
  async validateReport(input: unknown) {
    const out = input as Report;
    if (
      out.requestId !== this.request.id ||
      !["completed", "partial", "needs-human"].includes(out.status) ||
      !Array.isArray(out.rounds)
    )
      throw new Error("Invalid report");
    const source = await this.load();
    for (const [i, round] of out.rounds.entries()) {
      if (round.version !== i + 1) throw new Error("Invalid round version");
      review(round.review, round.draftId);
      const d = await this.loadDraft(round.draftId),
        p = await this.proof(round.checkId);
      if (
        p.sourceDigest !== source.digest ||
        p.draftId !== round.draftId ||
        JSON.stringify(p.issues) !== JSON.stringify(check(d, source)) ||
        JSON.stringify(p.issues) !== JSON.stringify(round.issues)
      )
        throw new Error("Check proof mismatch");
      const saved = await regular(
        join(this.directory, "reviews", `${round.version}.json`),
      );
      if (saved !== JSON.stringify(round.review))
        throw new Error("Review changed");
    }
    if (out.latestDraftId) await this.loadDraft(out.latestDraftId);
    if (out.status === "completed") {
      const last = out.rounds.at(-1);
      if (
        !last ||
        last.draftId !== out.acceptedDraftId ||
        last.draftId !== out.latestDraftId ||
        last.review.verdict !== "pass" ||
        last.issues.length ||
        last.review.issues.length
      )
        throw new Error("Unverified publication");
    } else if (out.acceptedDraftId !== null)
      throw new Error("Unverified accepted draft");
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
      tool("reflection_load", ["read"], async () => {
        const source = await this.load();
        let seed: Draft | null = null;
        if (this.request.seedDigest) {
          const raw = await regular(join(this.directory, "seed.json"));
          if (digest(raw) !== this.request.seedDigest)
            throw new Error("Seed changed");
          seed = draft(JSON.parse(raw));
        }
        return { status: "success", structuredContent: json({ source, seed }) };
      }),
      tool("reflection_authorize", ["read"], async () => {
        await this.load();
        return { status: "success", structuredContent: { authorized: true } };
      }),
      tool("reflection_save_draft", ["write"], async (a) => ({
        status: "success",
        structuredContent: json(await this.putDraft(a.draft)),
      })),
      tool("reflection_check", ["read", "write"], async (a) => {
        const d = await this.loadDraft(String(a.draftId)),
          s = await this.load(),
          issues = check(d, s),
          p = { sourceDigest: s.digest, draftId: draftId(d), issues },
          raw = JSON.stringify(p),
          checkId = digest(raw);
        await mkdir(join(this.directory, "checks"), { recursive: true });
        await immutable(join(this.directory, "checks", checkId + ".json"), raw);
        return {
          status: "success",
          structuredContent: json({ checkId, issues }),
        };
      }),
      tool("reflection_save_review", ["read", "write"], async (a) => {
        const id = hash(a.draftId);
        await this.loadDraft(id);
        const rev = review(a.review, id);
        if (
          !Number.isSafeInteger(a.version) ||
          Number(a.version) < 1 ||
          Number(a.version) > this.request.maxRounds
        )
          throw new Error("Invalid review version");
        await mkdir(join(this.directory, "reviews"), { recursive: true });
        await immutable(
          join(this.directory, "reviews", `${a.version}.json`),
          JSON.stringify(rev),
        );
        return { status: "success", structuredContent: { saved: true } };
      }),
      tool("reflection_publish", ["read", "write"], async (a) => {
        const out = await this.validateReport(a.report),
          dir = join(this.directory, "output");
        await mkdir(dir, { recursive: true });
        await immutable(
          join(dir, "report.json"),
          JSON.stringify(out, null, 2) + "\n",
        );
        const esc = (s: string) => s.replace(/[\\`*_\[\]<>#]/g, "\\$&");
        let body = `# Reflection / Self-Refine\n\nStatus: ${out.status}\nStop: ${out.stopReason}\n\n`;
        if (out.acceptedDraftId) {
          const d = await this.loadDraft(out.acceptedDraftId);
          body += `## ${esc(d.title)}\n\n| Metric | Value |\n| --- | ---: |\n| July net (cents) | ${d.metrics.baselineNetCents} |\n| August net (cents) | ${d.metrics.currentNetCents} |\n| Growth (%) | ${d.metrics.growthPercent} |\n\n${esc(d.interpretation)}\n\n### Limitations\n\n${d.limitations.map((x) => "- " + esc(x)).join("\n")}\n\n### Proposed actions\n\n${d.actions.map((x) => "- " + esc(x.owner) + ": " + esc(x.task)).join("\n")}\n\n### Sources\n\n${d.citations.map((c) => "- " + c.sourceId + ": " + esc(c.quote)).join("\n")}\n`;
          await immutable(
            join(dir, "analysis.json"),
            JSON.stringify(d, null, 2) + "\n",
          );
        } else
          body +=
            "No draft passed both deterministic checks and model review. Inspect saved drafts and review issues before using the content.\n";
        body +=
          "\n## Revision history\n\n" +
          out.rounds
            .map(
              (x) =>
                `- Version ${x.version}: ${x.review.verdict}; ${x.issues.length} deterministic issues; ${x.draftId}`,
            )
            .join("\n") +
          "\n";
        await immutable(join(dir, "report.md"), body);
        return { status: "success", structuredContent: { published: true } };
      }),
    ];
  }
}
