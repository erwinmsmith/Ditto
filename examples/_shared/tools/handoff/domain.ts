import { digest, identifier, object, text } from "../evidence.ts";
export const roles = [
  "customer-service",
  "technical-support",
  "after-sales",
] as const;
export type Agent = (typeof roles)[number];
export function agent(v: unknown): Agent {
  if (!roles.includes(v as Agent)) throw new Error("Unknown agent");
  return v as Agent;
}
export function hash(v: unknown): string {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))
    throw new Error("Invalid digest");
  return v;
}
function integer(v: unknown, min: number, max: number) {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max)
    throw new Error("Invalid limit");
  return Number(v);
}
export interface Request {
  id: string;
  tenant: string;
  principal: string;
  goal: string;
  sourceDigest: string;
  maxModelCalls: number;
  maxAttempts: number;
  maxTransfers: number;
  deadlineSeconds: number;
}
export function request(v: unknown): Request {
  const r = object(v);
  return {
    id: identifier(r.id),
    tenant: identifier(r.tenant),
    principal: identifier(r.principal),
    goal: text(r.goal, 2000),
    sourceDigest: hash(r.sourceDigest),
    maxModelCalls: integer(r.maxModelCalls, 1, 20),
    maxAttempts: integer(r.maxAttempts, 1, 3),
    maxTransfers: integer(r.maxTransfers, 1, 6),
    deadlineSeconds: integer(r.deadlineSeconds, 1, 3600),
  };
}
export interface Sources {
  orderId: string;
  issue: string;
  diagnostic: "hardware-fault" | "resolved" | "missing";
  warranty: boolean;
  customerEmail: string;
}
export function sources(v: unknown): Sources {
  const s = object(v);
  if (
    !["hardware-fault", "resolved", "missing"].includes(String(s.diagnostic)) ||
    typeof s.warranty !== "boolean"
  )
    throw new Error("Invalid sources");
  return {
    orderId: identifier(s.orderId),
    issue: text(s.issue),
    diagnostic: s.diagnostic as Sources["diagnostic"],
    warranty: s.warranty,
    customerEmail: text(s.customerEmail, 200),
  };
}
export interface Fact {
  id: string;
  quote: string;
}
export interface Evidence {
  agent: Agent;
  facts: Fact[];
  allowed: {
    action: "handoff" | "complete" | "escalate";
    to: Agent | null;
    resolution: "replacement-requested" | "resolved" | null;
  };
}
export function evidence(s: Sources, a: Agent): Evidence {
  const facts: Fact[] = [
    { id: "order", quote: `Order ${s.orderId}.` },
    { id: "issue", quote: s.issue },
  ];
  if (a !== "customer-service")
    facts.push({
      id: "diagnostic",
      quote: `Diagnostic record: ${s.diagnostic}.`,
    });
  if (a === "after-sales")
    facts.push({ id: "warranty", quote: `Warranty eligible: ${s.warranty}.` });
  return {
    agent: a,
    facts,
    allowed:
      a === "customer-service"
        ? { action: "handoff", to: "technical-support", resolution: null }
        : a === "technical-support"
          ? s.diagnostic === "missing"
            ? { action: "escalate", to: null, resolution: null }
            : s.diagnostic === "resolved"
              ? { action: "complete", to: null, resolution: "resolved" }
              : { action: "handoff", to: "after-sales", resolution: null }
          : s.warranty
            ? {
                action: "complete",
                to: null,
                resolution: "replacement-requested",
              }
            : { action: "escalate", to: null, resolution: null },
  };
}
export interface Decision {
  agent: Agent;
  action: Evidence["allowed"]["action"];
  to: Agent | null;
  resolution: Evidence["allowed"]["resolution"];
  summary: string;
  nextTask: string | null;
  citations: Fact[];
}
export function decision(v: unknown, e: Evidence): Decision {
  const d = object(v);
  if (
    d.agent !== e.agent ||
    d.action !== e.allowed.action ||
    d.to !== e.allowed.to ||
    d.resolution !== e.allowed.resolution ||
    !Array.isArray(d.citations) ||
    d.citations.length !== e.facts.length
  )
    throw new Error("Invalid owner decision");
  const citations = d.citations.map((x) => {
    const c = object(x);
    if (!e.facts.some((f) => f.id === c.id && f.quote === c.quote))
      throw new Error("Unsupported citation");
    return { id: String(c.id), quote: String(c.quote) };
  });
  if (new Set(citations.map((c) => c.id)).size !== e.facts.length)
    throw new Error("Incomplete evidence");
  const nextTask = d.action === "handoff" ? text(d.nextTask, 800) : null;
  if (d.action !== "handoff" && d.nextTask !== null)
    throw new Error("Unexpected next task");
  return {
    agent: e.agent,
    ...e.allowed,
    summary: text(d.summary, 1500),
    nextTask,
    citations,
  };
}
export interface Packet {
  requestDigest: string;
  version: number;
  from: Agent;
  to: Agent;
  decision: Decision;
  parentId: string | null;
}
export const packetId = (p: Packet) => digest(JSON.stringify(p));
export interface Acceptance {
  agent: Agent;
  packetId: string;
  accepted: true;
  summary: string;
}
export function acceptance(v: unknown, id: string, to: Agent): Acceptance {
  const a = object(v);
  if (a.agent !== to || a.packetId !== id || a.accepted !== true)
    throw new Error("Invalid handoff acceptance");
  return {
    agent: to,
    packetId: id,
    accepted: true,
    summary: text(a.summary, 1200),
  };
}
export interface Event {
  version: number;
  kind: "transfer" | "complete" | "escalate";
  from: Agent;
  to: Agent | null;
  packetId: string | null;
  decision: Decision;
  acceptance: Acceptance | null;
}
export interface Ticket {
  requestDigest: string;
  owner: Agent;
  version: number;
  status: "active" | "completed" | "needs-human";
  pending: { id: string; packet: Packet } | null;
  history: Event[];
  resolution: Evidence["allowed"]["resolution"];
}
export interface Report {
  requestId: string;
  status: "completed" | "partial" | "needs-human";
  stopReason: string;
  ticket: Ticket;
  usage: { modelCalls: number; startedAt: string };
  generatedAt: string;
}
