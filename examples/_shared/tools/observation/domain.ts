import { createHash } from "node:crypto";
import type {
  ExternalResult,
  Observation,
  JsonValue,
} from "@ditto/core/contracts";
export const modes = [
  "read",
  "normalize",
  "errors",
  "state",
  "interpret",
] as const;
export type Mode = (typeof modes)[number];
export const scenarios = [
  "success",
  "transient",
  "denied",
  "not-found",
  "timeout",
  "disconnect",
  "malformed",
  "business-failure",
  "cancelled",
  "persistent-transient",
] as const;
export type Scenario = (typeof scenarios)[number];
export interface Request {
  id: string;
  tenant: string;
  mode: Mode;
  scenario: Scenario;
  orderId: string;
  origin: string;
}
export type Action = "complete" | "retry" | "reconcile" | "escalate" | "stop";
export type State =
  | "pending"
  | "waiting_retry"
  | "reconciling"
  | "completed"
  | "needs_review"
  | "stopped";
export interface Decision {
  callId: string;
  orderId: string;
  totalCents: number | null;
  remoteState: "completed" | "failed" | "unknown";
  errorKind:
    | "none"
    | "transient"
    | "permission"
    | "not_found"
    | "timeout"
    | "transport"
    | "invalid_output"
    | "business"
    | "cancelled";
  nextAction: Action;
  reason: string;
}
export const json = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value));
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as Record<string, unknown>;
}
export function request(value: unknown): Request {
  const r = object(value);
  for (const field of ["id", "tenant", "orderId"])
    if (typeof r[field] !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(r[field]))
      throw new Error(`Invalid ${field}`);
  if (
    !modes.includes(r.mode as Mode) ||
    !scenarios.includes(r.scenario as Scenario) ||
    typeof r.origin !== "string" ||
    new URL(r.origin).origin !== r.origin ||
    !["http:", "https:"].includes(new URL(r.origin).protocol)
  )
    throw new Error("Invalid observation task");
  return {
    id: String(r.id),
    tenant: String(r.tenant),
    mode: r.mode as Mode,
    scenario: r.scenario as Scenario,
    orderId: String(r.orderId),
    origin: r.origin,
  };
}
export const stateFor = (action: Action): State =>
  (
    ({
      complete: "completed",
      retry: "waiting_retry",
      reconcile: "reconciling",
      escalate: "needs_review",
      stop: "stopped",
    }) as const
  )[action];
export function facts(
  result: ExternalResult,
  r: Request,
  round: number,
): Omit<Decision, "reason"> {
  const base: Omit<Decision, "reason"> = {
    callId: result.callId,
    orderId: r.orderId,
    totalCents: null,
    remoteState: "unknown",
    errorKind: "invalid_output",
    nextAction: "escalate",
  };
  if (result.status !== "success") {
    const map: Record<string, Decision["errorKind"]> = {
      HTTP_503: "transient",
      HTTP_403: "permission",
      HTTP_404: "not_found",
      REQUEST_TIMEOUT: "timeout",
      CONNECTION_LOST: "transport",
      REMOTE_CANCELLED: "cancelled",
    };
    base.errorKind = map[result.error?.code ?? ""] ?? "invalid_output";
    base.nextAction =
      base.errorKind === "cancelled"
        ? "stop"
        : round >= 1
          ? "escalate"
          : base.errorKind === "transient"
            ? "retry"
            : ["timeout", "transport"].includes(base.errorKind)
              ? "reconcile"
              : "escalate";
    return base;
  }
  try {
    let data: Record<string, unknown>;
    if (result.structuredContent !== undefined)
      data = object(result.structuredContent);
    else {
      if (typeof result.content !== "string") return base;
      const match =
        /^orderId,quantity,unitCents,status\n([A-Za-z0-9_-]+),(\d+),(\d+),(completed|failed)\n$/.exec(
          result.content,
        );
      if (!match) return base;
      data = {
        orderId: match[1],
        quantity: Number(match[2]),
        unitCents: Number(match[3]),
        status: match[4],
      };
    }
    if (data.orderId !== r.orderId) return base;
    if (data.status === "failed")
      return { ...base, remoteState: "failed", errorKind: "business" };
    if (
      data.status !== "completed" ||
      !Number.isSafeInteger(data.quantity) ||
      !Number.isSafeInteger(data.unitCents) ||
      Number(data.quantity) < 1 ||
      Number(data.unitCents) < 1 ||
      !Number.isSafeInteger(Number(data.quantity) * Number(data.unitCents))
    )
      return base;
    return {
      ...base,
      totalCents: Number(data.quantity) * Number(data.unitCents),
      remoteState: "completed",
      errorKind: "none",
      nextAction: "complete",
    };
  } catch {
    return base;
  }
}
export function verifyObservation(
  result: ExternalResult,
  observation: Observation,
) {
  for (const key of [
    "callId",
    "source",
    "status",
    "structuredContent",
    "error",
    "references",
    "metadata",
  ] as const)
    if (JSON.stringify(result[key]) !== JSON.stringify(observation[key]))
      throw new Error(`Observation lost ${key}`);
  if (
    observation.message.role !== "tool" ||
    observation.message.name !== result.source
  )
    throw new Error("Observation message lost tool identity");
}
export function validateDecision(
  value: unknown,
  result: ExternalResult,
  r: Request,
  round: number,
): Decision {
  const d = object(value),
    expected = facts(result, r, round);
  if (
    Object.keys(d).sort().join() !==
    [...Object.keys(expected), "reason"].sort().join()
  )
    throw new Error("Decision schema mismatch");
  for (const [key, value] of Object.entries(expected))
    if (d[key] !== value)
      throw new Error(`Decision contradicts evidence: ${key}`);
  if (
    typeof d.reason !== "string" ||
    !d.reason.trim() ||
    d.reason.length > 1000
  )
    throw new Error("Missing bounded explanation");
  return { ...expected, reason: d.reason };
}
