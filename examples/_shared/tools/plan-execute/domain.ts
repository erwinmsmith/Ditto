import { identifier, object, text } from "../evidence.ts";
export interface Request {
  id: string;
  tenant: string;
  principal: string;
  orderId: string;
  goal: string;
  quantity: number;
  maxShippingCents: number;
  maxPlans: number;
  maxActions: number;
  deadlineSeconds: number;
}
function integer(v: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max)
    throw new Error("Invalid task limit");
  return Number(v);
}
export function request(input: unknown): Request {
  const v = object(input);
  return {
    id: identifier(v.id),
    tenant: identifier(v.tenant),
    principal: identifier(v.principal),
    orderId: identifier(v.orderId),
    goal: text(v.goal),
    quantity: integer(v.quantity, 1, 100),
    maxShippingCents: integer(v.maxShippingCents, 0, 100000),
    maxPlans: integer(v.maxPlans, 1, 5),
    maxActions: integer(v.maxActions, 0, 30),
    deadlineSeconds: integer(v.deadlineSeconds, 1, 3600),
  };
}
export type Operation =
  | "reserve_stock"
  | "pack_order"
  | "ship_standard"
  | "ship_economy"
  | "read_receipt";
export const operations: Operation[] = [
  "reserve_stock",
  "pack_order",
  "ship_standard",
  "ship_economy",
  "read_receipt",
];
export interface Snapshot {
  state: "new" | "reserved" | "packed" | "shipped";
  stock: number;
  standard: number;
  economy: number;
  carrier: string | null;
  cost: number | null;
}
export interface Step {
  id: string;
  tool: Operation;
  dependsOn: string[];
  expected: "reserved" | "packed" | "shipped" | "receipt";
}
export interface Plan {
  goal: string;
  status: "ready" | "needs-human";
  reason: string;
  steps: Step[];
}
export function plan(input: unknown, r: Request, s: Snapshot): Plan {
  const v = object(input);
  if (
    !["ready", "needs-human"].includes(String(v.status)) ||
    !Array.isArray(v.steps)
  )
    throw new Error("Invalid plan schema");
  const feasible =
    (s.state !== "new" || s.stock >= r.quantity) &&
    (s.state === "shipped" ||
      Math.min(s.standard, s.economy) <= r.maxShippingCents);
  if (v.status === "needs-human") {
    if (feasible || v.steps.length) throw new Error("Unjustified escalation");
    return {
      goal: text(v.goal),
      status: "needs-human",
      reason: text(v.reason),
      steps: [],
    };
  }
  if (!feasible || v.steps.length > 4 || !v.steps.length)
    throw new Error("Infeasible plan");
  const required: Operation[] =
    s.state === "new"
      ? ["reserve_stock", "pack_order"]
      : s.state === "reserved"
        ? ["pack_order"]
        : [];
  const steps = v.steps.map((x: unknown, i: number): Step => {
    const a = object(x),
      tool = String(a.tool) as Operation;
    if (
      !operations.includes(tool) ||
      Object.keys(a).some(
        (k) => !["id", "tool", "dependsOn", "expected"].includes(k),
      )
    )
      throw new Error("Undeclared plan operation");
    if (!Array.isArray(a.dependsOn) || a.dependsOn.length !== (i ? 1 : 0))
      throw new Error("Invalid plan dependencies");
    return {
      id: identifier(a.id),
      tool,
      dependsOn: a.dependsOn.map(identifier),
      expected: String(a.expected) as Step["expected"],
    };
  });
  if (s.state !== "shipped") {
    const shipping = steps[required.length]?.tool;
    if (shipping !== "ship_standard" && shipping !== "ship_economy")
      throw new Error("Plan must include shipping");
    if (
      s[shipping === "ship_standard" ? "standard" : "economy"] >
      r.maxShippingCents
    )
      throw new Error("Shipping exceeds authorized budget");
    required.push(shipping);
  }
  required.push("read_receipt");
  const seen = new Set<string>();
  for (const [i, a] of steps.entries()) {
    const expected =
      a.tool === "reserve_stock"
        ? "reserved"
        : a.tool === "pack_order"
          ? "packed"
          : a.tool === "read_receipt"
            ? "receipt"
            : "shipped";
    if (
      seen.has(a.id) ||
      a.tool !== required[i] ||
      a.expected !== expected ||
      (i && a.dependsOn[0] !== steps[i - 1]!.id)
    )
      throw new Error("Invalid plan order or postcondition");
    seen.add(a.id);
  }
  if (steps.length !== required.length) throw new Error("Incomplete plan");
  return { goal: text(v.goal), status: "ready", reason: text(v.reason), steps };
}
export interface Completed {
  version: number;
  step: Step;
  evidenceId: string;
}
export interface Report {
  requestId: string;
  status: "completed" | "needs-human" | "partial";
  stopReason: string;
  plans: { version: number; snapshot: Snapshot; plan: Plan }[];
  completed: Completed[];
  changes: { version: number; stepId: string; code: string }[];
  usage: { modelCalls: number; actionCalls: number; startedAt: string };
  receipt: {
    orderId: string;
    quantity: number;
    carrier: string;
    cost: number;
    tracking: string;
  } | null;
  generatedAt: string;
}
