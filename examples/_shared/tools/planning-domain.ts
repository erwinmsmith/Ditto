/** Application contracts and admission rules for an inventory-report task. */
export type Mode = "plan" | "decompose" | "dependencies" | "budget" | "tools";
export type Role = "sales" | "stock" | "demand" | "replenish" | "report";
export interface Budget { maxModelCalls: number; maxToolCalls: number; maxCostCents: number; maxElapsedMs: number; concurrency: number; ioSlots: number; cpuSlots: number; memoryUnits: number }
export interface Request { goal: string; salesFormat: "json" | "csv"; analysis: "basic" | "detailed" | "best_available"; horizonDays: number; budget: Budget; allowedTools: string[] }
export interface ToolSpec { name: string; role: Role; description: string; costCents: number; durationMs: number; resource: "io" | "cpu"; memoryUnits: number }
export interface Task { id: string; role: Role; tool: string; dependsOn: string[]; reason: string }
export interface Plan { goal: string; tasks: Task[] }
export interface Schedule { waves: string[][]; costCents: number; toolCalls: number; estimatedMs: number; criticalPathMs: number; peakMemoryUnits: number }
export const modelCostCents = 20, modelEstimateMs = 2000;
export const catalog: readonly ToolSpec[] = [
  { name: "planning_sales_json", role: "sales", description: "Read sales.json: SKU with daily sales quantities.", costCents: 2, durationMs: 10, resource: "io", memoryUnits: 1 },
  { name: "planning_sales_csv", role: "sales", description: "Read sales.csv: sku,day,quantity; aggregate rows by SKU.", costCents: 4, durationMs: 15, resource: "io", memoryUnits: 1 },
  { name: "planning_stock", role: "stock", description: "Read stock.json: SKU and available inventory.", costCents: 2, durationMs: 10, resource: "io", memoryUnits: 1 },
  { name: "planning_demand_basic", role: "demand", description: "Estimate daily demand from average sales; use for basic or cost-limited requests.", costCents: 4, durationMs: 20, resource: "cpu", memoryUnits: 1 },
  { name: "planning_demand_detailed", role: "demand", description: "Estimate demand from the maximum daily sales; include a conservative safety margin.", costCents: 12, durationMs: 40, resource: "cpu", memoryUnits: 2 },
  { name: "planning_replenish", role: "replenish", description: "Combine demand and stock, computing max(0, ceil(dailyDemand * horizonDays) - available).", costCents: 5, durationMs: 10, resource: "cpu", memoryUnits: 1 },
  { name: "planning_report", role: "report", description: "Generate local JSON and Markdown reports from computed replenishment rows; no purchases or publication.", costCents: 3, durationMs: 10, resource: "io", memoryUnits: 1 },
];
export const requirements: Record<Role, Role[]> = { sales: [], stock: [], demand: ["sales"], replenish: ["demand", "stock"], report: ["replenish"] };
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object"); return value as Record<string, unknown>; }
export function text(value: unknown, max = 400): string { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid text"); return value; }
export function identifier(value: unknown): string { const s = text(value, 64); if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(s) || ["__proto__", "constructor", "prototype"].includes(s)) throw new Error("Invalid identifier"); return s; }
export function integer(value: unknown, min: number, max: number): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid integer"); return value; }
export const toolSpec = (name: string) => { const spec = catalog.find(t => t.name === name); if (!spec) throw new Error("Unknown tool"); return spec; };
export function request(value: unknown): Request {
  const x = object(value), b = object(x.budget);
  if (!["json", "csv"].includes(String(x.salesFormat)) || !["basic", "detailed", "best_available"].includes(String(x.analysis))) throw new Error("Invalid request mode");
  if (!Array.isArray(x.allowedTools) || x.allowedTools.some(v => typeof v !== "string" || !catalog.some(t => t.name === v)) || new Set(x.allowedTools).size !== x.allowedTools.length) throw new Error("Invalid tool allowlist");
  return { goal: text(x.goal, 1000), salesFormat: x.salesFormat as Request["salesFormat"], analysis: x.analysis as Request["analysis"], horizonDays: integer(x.horizonDays, 1, 30), allowedTools: x.allowedTools as string[], budget: {
    maxModelCalls: integer(b.maxModelCalls, 0, 10), maxToolCalls: integer(b.maxToolCalls, 0, 100), maxCostCents: integer(b.maxCostCents, 0, 100000), maxElapsedMs: integer(b.maxElapsedMs, 1, 3600000), concurrency: integer(b.concurrency, 1, 8), ioSlots: integer(b.ioSlots, 0, 8), cpuSlots: integer(b.cpuSlots, 0, 8), memoryUnits: integer(b.memoryUnits, 0, 16),
  } };
}
export function validatePlan(value: unknown, input: Request): { plan: Plan; schedule: Schedule } {
  const x = object(value); if (!Array.isArray(x.tasks) || x.tasks.length !== 5) throw new Error("Plan requires five distinct roles");
  const seen = new Set<string>(), roles = new Set<Role>();
  const tasks = x.tasks.map(raw => {
    const t = object(raw), id = identifier(t.id), name = text(t.tool), spec = toolSpec(name);
    if (seen.has(id) || roles.has(spec.role) || t.role !== spec.role || !input.allowedTools.includes(name)) throw new Error("Duplicate role/ID or unauthorized tool");
    if (!Array.isArray(t.dependsOn)) throw new Error("Missing dependencies"); const dependsOn = t.dependsOn.map(identifier);
    if (new Set(dependsOn).size !== dependsOn.length || dependsOn.includes(id)) throw new Error("Duplicate or self dependency");
    seen.add(id); roles.add(spec.role); return { id, role: spec.role, tool: name, dependsOn, reason: text(t.reason) };
  });
  for (const task of tasks) {
    const dependencies = task.dependsOn.map(id => tasks.find(t => t.id === id));
    if (dependencies.some(t => !t)) throw new Error("Unknown dependency");
    const actual = dependencies.map(t => t!.role).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...requirements[task.role]].sort())) throw new Error("Dependency contract mismatch or cycle");
  }
  if (tasks.find(t => t.role === "sales")!.tool !== `planning_sales_${input.salesFormat}`) throw new Error("Sales decoder does not match input");
  const demand = tasks.find(t => t.role === "demand")!.tool;
  if ((input.analysis === "basic" && demand !== "planning_demand_basic") || (input.analysis === "detailed" && demand !== "planning_demand_detailed")) throw new Error("Analysis quality constraint violated");
  const plan = { goal: text(x.goal, 1000), tasks };
  const schedule = schedulePlan(plan, input.budget);
  if (schedule.toolCalls > input.budget.maxToolCalls || schedule.costCents > input.budget.maxCostCents || schedule.estimatedMs > input.budget.maxElapsedMs) throw new Error("Plan exceeds budget");
  return { plan, schedule };
}
export function schedulePlan(plan: Plan, budget: Budget): Schedule {
  const done = new Set<string>(), waves: string[][] = [], finish = new Map<string, number>(); let elapsed = modelEstimateMs, peakMemoryUnits = 0;
  while (done.size < plan.tasks.length) {
    const ready = plan.tasks.filter(t => !done.has(t.id) && t.dependsOn.every(d => done.has(d))).sort((a,b) => a.id.localeCompare(b.id));
    const wave: Task[] = []; let io = 0, cpu = 0, memory = 0;
    for (const task of ready) { const spec = toolSpec(task.tool); if (wave.length >= budget.concurrency || memory + spec.memoryUnits > budget.memoryUnits || (spec.resource === "io" ? io >= budget.ioSlots : cpu >= budget.cpuSlots)) continue;
      wave.push(task); memory += spec.memoryUnits; if (spec.resource === "io") io++; else cpu++;
    }
    if (!wave.length) throw new Error("Cycle or insufficient resources");
    waves.push(wave.map(t => t.id)); peakMemoryUnits = Math.max(peakMemoryUnits, memory);
    elapsed += Math.max(...wave.map(t => toolSpec(t.tool).durationMs));
    for (const task of wave) { done.add(task.id); finish.set(task.id, Math.max(0, ...task.dependsOn.map(d => finish.get(d)!)) + toolSpec(task.tool).durationMs); }
  }
  return { waves, costCents: modelCostCents + plan.tasks.reduce((n,t) => n + toolSpec(t.tool).costCents,0), toolCalls: plan.tasks.length, estimatedMs: elapsed, criticalPathMs: Math.max(...finish.values()), peakMemoryUnits };
}
/** A lower bound for admission, not the model's executable plan. */
export function preflight(input: Request): string | null {
  if (input.budget.maxModelCalls < 1) return "MODEL_BUDGET";
  for (const quality of input.analysis === "best_available" ? ["basic", "detailed"] : [input.analysis]) {
    const tasks = (Object.keys(requirements) as Role[]).map(role => ({ id: role, role, tool: role === "sales" ? `planning_sales_${input.salesFormat}` : role === "demand" ? `planning_demand_${quality}` : `planning_${role}`, dependsOn: requirements[role], reason: "Admission lower bound" }));
    try { validatePlan({ goal: input.goal, tasks }, input); return null; } catch { /* Try another permitted quality within the limits. */ }
  }
  return "NO_FEASIBLE_PLAN";
}
