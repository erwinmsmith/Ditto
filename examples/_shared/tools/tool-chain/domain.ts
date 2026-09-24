import { identifier, object, text } from "../evidence.ts";
export interface Request {
  id: string;
  tenant: string;
  principal: string;
  customerId: string;
  orderId: string;
  recipient: string;
  origin: string;
  goal: string;
  mode: "serial" | "parallel" | "conditional";
  allowCrmWrite: boolean;
  allowNotify: boolean;
  maxRounds: number;
  maxModelCalls: number;
  maxEffects: number;
  maxEffectAttempts: number;
  deadlineSeconds: number;
}
function integer(v: unknown, min: number, max: number) {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max)
    throw new Error("Invalid task limit");
  return Number(v);
}
export function request(input: unknown): Request {
  const r = object(input),
    u = new URL(text(r.origin));
  if (
    (u.protocol !== "https:" &&
      !(u.protocol === "http:" && u.hostname === "127.0.0.1")) ||
    u.origin !== r.origin ||
    u.username ||
    u.password
  )
    throw new Error("Invalid service origin");
  if (
    !["serial", "parallel", "conditional"].includes(String(r.mode)) ||
    typeof r.allowCrmWrite !== "boolean" ||
    typeof r.allowNotify !== "boolean"
  )
    throw new Error("Invalid execution policy");
  const recipient = text(r.recipient, 150);
  if (!/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+$/.test(recipient))
    throw new Error("Invalid notification recipient");
  return {
    id: identifier(r.id),
    tenant: identifier(r.tenant),
    principal: identifier(r.principal),
    customerId: identifier(r.customerId),
    orderId: identifier(r.orderId),
    recipient,
    origin: u.origin,
    goal: text(r.goal),
    mode: r.mode as Request["mode"],
    allowCrmWrite: r.allowCrmWrite,
    allowNotify: r.allowNotify,
    maxRounds: integer(r.maxRounds, 1, 4),
    maxModelCalls: integer(r.maxModelCalls, 1, 4),
    maxEffects: integer(r.maxEffects, 0, 8),
    maxEffectAttempts: integer(r.maxEffectAttempts, 1, 3),
    deadlineSeconds: integer(r.deadlineSeconds, 1, 3600),
  };
}
export interface Snapshot {
  customer: { customerId: string; recipient: string; active: boolean };
  order: { orderId: string; customerId: string; revision: number };
  payment: { orderId: string; revision: number; state: "paid" | "pending" };
  shipment: { orderId: string; revision: number; state: "shipped" | "delayed" };
}
export interface Decision {
  customerId: string;
  orderId: string;
  revision: number;
  status: "healthy" | "attention";
  reasonCode: "CLEAR" | "PAYMENT_PENDING" | "SHIPMENT_DELAYED";
  updateCrm: boolean;
  notify: boolean;
  explanation: string;
}
export function snapshot(v: unknown, r: Request): Snapshot {
  const s = v as Snapshot;
  if (
    s.customer.customerId !== r.customerId ||
    s.customer.recipient !== r.recipient ||
    s.customer.active !== true ||
    s.order.orderId !== r.orderId ||
    s.order.customerId !== r.customerId ||
    s.payment.orderId !== r.orderId ||
    s.shipment.orderId !== r.orderId
  )
    throw new Error("Scope mismatch");
  integer(s.order.revision, 1, 1000000);
  if (
    s.payment.revision !== s.order.revision ||
    s.shipment.revision !== s.order.revision
  )
    throw new Error("INCONSISTENT_READ");
  if (
    !["paid", "pending"].includes(s.payment.state) ||
    !["shipped", "delayed"].includes(s.shipment.state)
  )
    throw new Error("Invalid business state");
  return s;
}
export function expected(s: Snapshot, r: Request) {
  const reasonCode =
      s.payment.state === "pending"
        ? "PAYMENT_PENDING"
        : s.shipment.state === "delayed"
          ? "SHIPMENT_DELAYED"
          : "CLEAR",
    status = reasonCode === "CLEAR" ? "healthy" : "attention",
    updateCrm = r.mode !== "conditional" || status === "attention";
  return {
    customerId: r.customerId,
    orderId: r.orderId,
    revision: s.order.revision,
    status,
    reasonCode,
    updateCrm,
    notify: updateCrm,
  } as const;
}
export function decision(input: unknown, s: Snapshot, r: Request): Decision {
  const v = object(input),
    e = expected(s, r);
  for (const [k, value] of Object.entries(e))
    if (v[k] !== value)
      throw new Error(
        "Decision disagrees with verified business facts or routing policy",
      );
  return { ...e, explanation: text(v.explanation, 800) };
}
export function payload(d: Decision, r: Request) {
  return {
    customerId: r.customerId,
    orderId: r.orderId,
    revision: d.revision,
    status: d.status,
    reasonCode: d.reasonCode,
    recipient: r.recipient,
    message: `Customer ${r.customerId}; order ${r.orderId}; revision ${d.revision}; status ${d.status}; reason ${d.reasonCode}.`,
  };
}
export interface Receipt {
  key: string;
  kind: "crm" | "notify";
  payload: ReturnType<typeof payload>;
}
export interface Report {
  requestId: string;
  status: "completed" | "partial" | "needs-human";
  stopReason: string;
  rounds: {
    round: number;
    reads: unknown;
    decision: Decision | null;
    problem: string | null;
  }[];
  effects: {
    kind: "crm" | "notify";
    attempt: number;
    status: string;
    code: string | null;
  }[];
  crm: Receipt | null;
  notification: Receipt | null;
  verificationId: string | null;
  usage: { modelCalls: number; effectCalls: number; startedAt: string };
  generatedAt: string;
}
