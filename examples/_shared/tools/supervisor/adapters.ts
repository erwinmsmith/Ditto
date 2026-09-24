import { mkdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import { immutable } from "../execution/files.ts";
import { digest, json, object } from "../evidence.ts";
import { hash } from "../multi-agent/domain.ts";
import {
  request,
  sources,
  evidence,
  finding,
  resultId,
  roles,
  decision,
  initialState,
  type Request,
  type Sources,
  type Saved,
  type Report,
  type Specialist,
} from "./domain.ts";
async function file(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 1000000)
    throw new Error("Invalid task file");
  return readFile(path, "utf8");
}
export type Scenario =
  | "recheck"
  | "ready"
  | "still-blocked"
  | "missing-verification"
  | "operations-blocked";
export async function createDemo(
  directory: string,
  options: Partial<Omit<Request, "sourceDigest">> = {},
  scenario: Scenario = "recheck",
) {
  if (
    ![
      "recheck",
      "ready",
      "still-blocked",
      "missing-verification",
      "operations-blocked",
    ].includes(scenario)
  )
    throw new Error("Invalid scenario");
  await mkdir(directory, { recursive: true });
  const source: Sources = {
      base: {
        releaseId: "REL-204",
        engineering: {
          total: 50,
          passed:
            scenario === "ready" || scenario === "operations-blocked" ? 50 : 48,
          criticalOpen: 0,
        },
        operations: {
          rollbackVerified: true,
          oncallAssigned: scenario !== "operations-blocked",
        },
      },
      verification:
        scenario === "missing-verification"
          ? null
          : {
              runId: "RERUN-205",
              total: 50,
              passed: scenario === "still-blocked" ? 49 : 50,
              criticalOpen: 0,
            },
    },
    r = request({
      id: randomUUID(),
      tenant: "demo",
      principal: "operator",
      goal: "由主管协调工程和运维评审，检查每次交接；若初始测试有缺口，委派核验 Agent 阅读复测记录，再给出发布准备度结论。",
      maxRounds: 6,
      maxModelCalls: 12,
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
export class SupervisorAdapters {
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
      s = JSON.parse(raw) as Saved;
    if (
      digest(raw) !== id ||
      s.requestDigest !== digest(JSON.stringify(this.request)) ||
      !roles.includes(s.finding.agent)
    )
      throw new Error("Result checksum or scope mismatch");
    finding(
      s.finding,
      evidence(await this.load(), s.finding.agent),
      s.finding.assignmentId,
    );
    return s;
  }
  async parent(agent: Specialist, parentId: unknown) {
    if (agent === "verification") {
      const id = hash(parentId),
        saved = await this.result(id);
      if (
        saved.finding.agent !== "engineering" ||
        saved.finding.verdict !== "blocked"
      )
        throw new Error("Verification requires a blocked engineering handoff");
      return id;
    }
    if (parentId !== null) throw new Error("Unexpected parent");
    return null;
  }
  async verify(out: Report) {
    await this.load();
    if (out.requestId !== this.request.id)
      throw new Error("Report scope mismatch");
    const state = initialState();
    let terminal = false,
      incomplete = false;
    for (const [index, round] of out.rounds.entries()) {
      if (
        round.round !== index + 1 ||
        new Set(round.outcomes.map((x) => x.agent)).size !==
          round.outcomes.length
      )
        throw new Error("Invalid round history");
      if (terminal || incomplete)
        throw new Error("Action after terminal decision");
      const d = decision(round.decision, state, this.request);
      terminal = d.action !== "delegate";
      incomplete =
        d.action === "delegate" &&
        round.outcomes.length !== d.assignments.length;
      if (round.outcomes.length > d.assignments.length)
        throw new Error("Unexpected outcomes");
      for (const item of round.outcomes) {
        if (
          !d.assignments.some((x) => x.agent === item.agent) ||
          item.assignmentId !== `r${round.round}-${item.agent}`
        )
          throw new Error("Unassigned result");
        state.attempts[item.agent]++;
        if (item.resultId) {
          const s = await this.result(item.resultId);
          if (
            s.finding.agent !== item.agent ||
            s.finding.assignmentId !== item.assignmentId ||
            s.parentId !==
              (item.agent === "verification"
                ? state.results.engineering!.resultId
                : null)
          )
            throw new Error("Handoff lineage changed");
          state.results[item.agent] = {
            resultId: item.resultId,
            finding: s.finding,
          };
        } else state.errors[item.agent].push(item.error ?? "unknown");
      }
    }
    if (JSON.stringify(state) !== JSON.stringify(out.state))
      throw new Error("Report state mismatch");
    const last = out.rounds.at(-1)?.decision;
    if (
      out.status === "completed" &&
      (last?.action !== "finish" ||
        JSON.stringify(last.conclusion) !== JSON.stringify(out.conclusion))
    )
      throw new Error("Unapproved supervisor conclusion");
    if (out.status !== "completed" && out.conclusion !== null)
      throw new Error("Unexpected conclusion");
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
      tool("sup_authorize", async () => {
        await this.load();
        return { status: "success", structuredContent: { authorized: true } };
      }),
      ...roles.map((agent) =>
        tool(`sup_read_${agent}`, async (a) => {
          if (Object.keys(a).length !== 1)
            throw new Error("Fixed evidence scope required");
          await this.parent(agent, a.parentId);
          return {
            status: "success",
            structuredContent: json(evidence(await this.load(), agent)),
          };
        }),
      ),
      tool("sup_save", async (a) => {
        const agent = String(a.agent) as Specialist;
        if (!roles.includes(agent)) throw new Error("Unknown specialist");
        const parentId = await this.parent(agent, a.parentId),
          source = await this.load();
        let f;
        try {
          if (
            typeof a.assignmentId !== "string" ||
            !/^r[1-8]-(engineering|operations|verification)$/.test(
              a.assignmentId,
            )
          )
            throw new Error("Bad assignment");
          f = finding(a.finding, evidence(source, agent), a.assignmentId);
        } catch {
          return {
            status: "failed",
            error: {
              code: "INVALID_FINDING",
              message: "Specialist output failed validation",
            },
          };
        }
        const s: Saved = {
            requestDigest: digest(JSON.stringify(this.request)),
            finding: f,
            parentId,
          },
          id = resultId(s);
        await mkdir(join(this.directory, "results"), { recursive: true });
        await immutable(
          join(this.directory, "results", id + ".json"),
          JSON.stringify(s),
        );
        return { status: "success", structuredContent: { resultId: id } };
      }),
      tool("sup_result", async (a) => ({
        status: "success",
        structuredContent: json(await this.result(hash(a.id))),
      })),
      tool("sup_publish", async (a) => {
        const out = a.report as unknown as Report;
        await this.verify(out);
        const dir = join(this.directory, "output");
        await mkdir(dir, { recursive: true });
        await immutable(
          join(dir, "report.json"),
          JSON.stringify(out, null, 2) + "\n",
        );
        await immutable(
          join(dir, "report.md"),
          `# Supervisor release review\n\nStatus: ${out.status}\nStop: ${out.stopReason}\nReadiness: ${out.conclusion?.verdict ?? "not concluded"}\n\n${out.conclusion?.summary ?? "No accepted final conclusion."}\n\n` +
            out.rounds
              .map(
                (x) =>
                  `## Round ${x.round}: ${x.decision.action}\n\n${x.decision.reason}\n\n` +
                  x.outcomes
                    .map((o) => `- ${o.agent}: ${o.resultId ?? o.error}`)
                    .join("\n"),
              )
              .join("\n\n") +
            "\n\n" +
            Object.values(out.state.results)
              .map(
                (h) =>
                  `## ${h.finding.agent}\n\n${h.finding.summary}\n\n` +
                  h.finding.citations
                    .map((c) => `- ${c.id}: ${c.quote}`)
                    .join("\n"),
              )
              .join("\n\n") +
            "\n",
        );
        return { status: "success", structuredContent: { published: true } };
      }),
    ];
  }
}
