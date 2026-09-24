import { digest, identifier, object, text, strings } from "../evidence.ts";
export const specialists = ["engineering", "operations"] as const;
export type Specialist = (typeof specialists)[number];
export type Agent = Specialist | "planner" | "synthesis";
export const agents = {
  planner: { purpose: "Decompose the release-readiness review", tools: [] },
  engineering: {
    purpose: "Assess tests and critical defects",
    tools: ["team_read_engineering"],
  },
  operations: {
    purpose: "Assess rollback and on-call readiness",
    tools: ["team_read_operations"],
  },
  synthesis: {
    purpose: "Combine verified specialist handoffs",
    tools: ["team_result"],
  },
} as const;
export interface Request {
  id: string;
  tenant: string;
  principal: string;
  goal: string;
  sourceDigest: string;
  mode: "parallel" | "serial";
  maxModelCalls: number;
  maxAgentAttempts: number;
  deadlineSeconds: number;
}
function integer(v: unknown, min: number, max: number) {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max)
    throw new Error("Invalid limit");
  return Number(v);
}
export function hash(v: unknown) {
  const s = text(v, 64);
  if (!/^[a-f0-9]{64}$/.test(s)) throw new Error("Invalid hash");
  return s;
}
export function request(v: unknown): Request {
  const r = object(v);
  if (!["parallel", "serial"].includes(String(r.mode)))
    throw new Error("Invalid mode");
  return {
    id: identifier(r.id),
    tenant: identifier(r.tenant),
    principal: identifier(r.principal),
    goal: text(r.goal, 2000),
    sourceDigest: hash(r.sourceDigest),
    mode: r.mode as Request["mode"],
    maxModelCalls: integer(r.maxModelCalls, 1, 10),
    maxAgentAttempts: integer(r.maxAgentAttempts, 1, 3),
    deadlineSeconds: integer(r.deadlineSeconds, 1, 3600),
  };
}
export interface Sources {
  releaseId: string;
  engineering: { total: number; passed: number; criticalOpen: number };
  operations: { rollbackVerified: boolean; oncallAssigned: boolean };
}
export function sources(v: unknown): Sources {
  const s = object(v),
    e = object(s.engineering),
    o = object(s.operations),
    total = integer(e.total, 1, 100000),
    passed = integer(e.passed, 0, total);
  if (
    typeof o.rollbackVerified !== "boolean" ||
    typeof o.oncallAssigned !== "boolean"
  )
    throw new Error("Invalid operations data");
  return {
    releaseId: identifier(s.releaseId),
    engineering: {
      total,
      passed,
      criticalOpen: integer(e.criticalOpen, 0, 1000),
    },
    operations: {
      rollbackVerified: o.rollbackVerified,
      oncallAssigned: o.oncallAssigned,
    },
  };
}
export interface Task {
  id: Specialist | "synthesis";
  agent: Specialist | "synthesis";
  goal: string;
  dependsOn: (Specialist | "synthesis")[];
}
export interface Plan {
  tasks: Task[];
}
export function plan(v: unknown, r: Request): Plan {
  const p = object(v);
  if (!Array.isArray(p.tasks) || p.tasks.length !== 3)
    throw new Error("Plan requires two specialists and synthesis");
  const tasks = p.tasks.map((value) => {
    const t = object(value),
      id = String(t.id);
    if (![...specialists, "synthesis"].includes(id) || t.agent !== id)
      throw new Error("Unknown agent or task");
    const dependencies = strings(t.dependsOn, 2),
      expected =
        id === "synthesis"
          ? [...specialists]
          : id === "operations" && r.mode === "serial"
            ? ["engineering"]
            : [];
    if (
      JSON.stringify([...dependencies].sort()) !==
      JSON.stringify(expected.sort())
    )
      throw new Error("Invalid dependencies");
    return {
      id: id as Task["id"],
      agent: id as Task["agent"],
      goal: text(t.goal, 600),
      dependsOn: dependencies as Task["dependsOn"],
    };
  });
  if (new Set(tasks.map((t) => t.id)).size !== 3)
    throw new Error("Duplicate task");
  return {
    tasks: ([...specialists, "synthesis"] as const).map(
      (id) => tasks.find((t) => t.id === id)!,
    ),
  };
}
export interface Evidence {
  agent: Specialist;
  releaseId: string;
  verdict: "ready" | "blocked";
  facts: { id: string; quote: string }[];
}
export function evidence(s: Sources, agent: Specialist): Evidence {
  return {
    agent,
    releaseId: s.releaseId,
    verdict:
      agent === "engineering"
        ? s.engineering.passed === s.engineering.total &&
          s.engineering.criticalOpen === 0
          ? "ready"
          : "blocked"
        : s.operations.rollbackVerified && s.operations.oncallAssigned
          ? "ready"
          : "blocked",
    facts:
      agent === "engineering"
        ? [
            {
              id: "tests",
              quote: `${s.engineering.passed}/${s.engineering.total} tests passed.`,
            },
            {
              id: "defects",
              quote: `${s.engineering.criticalOpen} critical defects open.`,
            },
          ]
        : [
            {
              id: "rollback",
              quote: `Rollback verified: ${s.operations.rollbackVerified}.`,
            },
            {
              id: "oncall",
              quote: `On-call assigned: ${s.operations.oncallAssigned}.`,
            },
          ],
  };
}
export interface Finding {
  agent: Specialist;
  taskId: Specialist;
  releaseId: string;
  verdict: "ready" | "blocked";
  summary: string;
  citations: { id: string; quote: string }[];
}
export function finding(v: unknown, e: Evidence): Finding {
  const f = object(v);
  if (
    f.agent !== e.agent ||
    f.taskId !== e.agent ||
    f.releaseId !== e.releaseId ||
    f.verdict !== e.verdict ||
    !Array.isArray(f.citations) ||
    f.citations.length !== e.facts.length
  )
    throw new Error("Invalid specialist result");
  const citations = f.citations.map((v) => {
    const c = object(v);
    if (!e.facts.some((x) => x.id === c.id && x.quote === c.quote))
      throw new Error("Unsupported specialist citation");
    return { id: String(c.id), quote: String(c.quote) };
  });
  if (new Set(citations.map((c) => c.id)).size !== e.facts.length)
    throw new Error("Missing citations");
  return {
    agent: e.agent,
    taskId: e.agent,
    releaseId: e.releaseId,
    verdict: e.verdict,
    summary: text(f.summary, 1500),
    citations,
  };
}
export interface Saved {
  requestDigest: string;
  finding: Finding;
  dependencies: string[];
}
export const resultId = (s: Saved) => digest(JSON.stringify(s));
export interface Handoff {
  resultId: string;
  finding: Finding;
}
export interface Summary {
  title: string;
  summary: string;
  verdict: "ready" | "blocked" | "incomplete";
  sections: { agent: Specialist; resultId: string; summary: string }[];
  missingAgents: Specialist[];
}
export function summary(v: unknown, results: Handoff[]): Summary {
  const s = object(v),
    missing = specialists.filter(
      (a) => !results.some((x) => x.finding.agent === a),
    ),
    verdict = missing.length
      ? "incomplete"
      : results.some((x) => x.finding.verdict === "blocked")
        ? "blocked"
        : "ready";
  if (
    s.verdict !== verdict ||
    !Array.isArray(s.sections) ||
    s.sections.length !== results.length ||
    JSON.stringify(strings(s.missingAgents, 2).sort()) !==
      JSON.stringify([...missing].sort())
  )
    throw new Error("Summary coverage or verdict mismatch");
  const sections = s.sections.map((v) => {
    const section = object(v),
      parent = results.find(
        (r) =>
          r.resultId === section.resultId && r.finding.agent === section.agent,
      );
    if (!parent) throw new Error("Unknown handoff");
    return {
      agent: parent.finding.agent,
      resultId: parent.resultId,
      summary: text(section.summary, 1500),
    };
  });
  if (new Set(sections.map((s) => s.agent)).size !== results.length)
    throw new Error("Duplicate summary agent");
  return {
    title: text(s.title, 200),
    summary: text(s.summary, 2000),
    verdict,
    sections,
    missingAgents: missing,
  };
}
export interface Entry {
  agent: Specialist;
  status: "completed" | "failed" | "blocked" | "skipped";
  resultId: string | null;
  attempts: number;
  errors: string[];
}
export interface Report {
  requestId: string;
  status: "completed" | "partial" | "needs-human";
  stopReason: string;
  plan: Plan | null;
  entries: Entry[];
  summary: Summary | null;
  usage: { modelCalls: number; startedAt: string };
  generatedAt: string;
}
