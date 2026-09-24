/** Application ledger and actual file/compute tools for inventory planning. */
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, writeFile, rename, rm, link } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonObject } from "@codesoul-co/ditto/contracts";
import type { RegisteredTool, OutputSink } from "@codesoul-co/ditto/worker/interaction";
import { catalog, integer, object, request, text, validatePlan, preflight, modelCostCents, modelEstimateMs, toolSpec, type Mode, type Request, type Plan, type Schedule, type Role } from "./planning-domain.ts";
export type Status = "received" | "planning" | "planned" | "running" | "completed" | "blocked" | "failed" | "cancelled";
export interface Checkpoint { taskId: string; status: "running" | "completed"; output: unknown }
export interface Row { sku: string; dailyDemand: number; available: number; quantity: number }
export interface Job {
  id: string; namespace: string; mode: Mode; status: Status; reason: string | null; owner: string | null;
  request: Request; createdAt: number; sourceDigests: Record<string,string>; plan: Plan | null; schedule: Schedule | null;
  checkpoints: Checkpoint[]; usage: { modelCalls: number; toolCalls: number; costCents: number };
  planArchived: boolean; resultArchived: boolean; delivered: boolean; rows: Row[] | null;
}
export const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export async function immutable(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content, { flag: "wx" }); try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(path, "utf8") !== content) throw error; }
  } finally { await rm(temporary, { force: true }); }
}
export class PlanningStore {
  readonly directory: string; readonly db: DatabaseSync;
  constructor(directory: string) {
    this.directory = directory; this.db = new DatabaseSync(join(directory, "planning.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS job(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,kind TEXT,data TEXT NOT NULL);");
  }
  private tx<T>(operation: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const out = operation(); this.db.exec("COMMIT"); return out; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  job(): Job { const row = this.db.prepare("SELECT data FROM job WHERE id='job'").get(); if (!row) throw new Error("Unknown job"); return JSON.parse(String(row.data)) as Job; }
  private save(s: Job, kind: string) { this.db.prepare("UPDATE job SET data=? WHERE id='job'").run(JSON.stringify(s)); this.db.prepare("INSERT INTO events(kind,data) VALUES(?,?)").run(kind, JSON.stringify({ status: s.status, usage: s.usage, owner: s.owner })); }
  async create(mode: Mode) {
    const input = request(JSON.parse(await readFile(join(this.directory, "request.json"), "utf8")));
    if (!["plan", "decompose", "dependencies", "budget", "tools"].includes(mode)) throw new Error("Invalid example mode");
    const sourceDigests: Record<string,string> = {};
    for (const file of [`sales.${input.salesFormat}`, "stock.json"]) sourceDigests[file] = hash(await readFile(join(this.directory,file),"utf8"));
    const s: Job = { id: "job", namespace: randomUUID(), mode, status: "received", reason: null, owner: null, request: input, createdAt: Date.now(), sourceDigests, plan: null, schedule: null, checkpoints: [], usage: { modelCalls: 0, toolCalls: 0, costCents: 0 }, planArchived: false, resultArchived: false, delivered: false, rows: null };
    this.tx(() => { this.db.prepare("INSERT INTO job VALUES('job',?)").run(JSON.stringify(s)); this.save(s, "created"); }); return s;
  }
  /** Trusted controller only: a running owner must first be confirmed stopped outside this adapter. */
  retry(stoppedOwner?: string) {
    return this.tx(() => {
      const s = this.job();
      if (!["failed", "running", "planning"].includes(s.status) || (s.owner !== null && s.owner !== stoppedOwner)) throw new Error("Retry requires failed work or the confirmed stopped owner");
      s.checkpoints = s.checkpoints.filter(c => c.status === "completed"); s.status = s.plan ? "planned" : "received"; s.owner = null; s.reason = null; s.delivered = false;
      this.save(s, "controller-retry"); return s;
    });
  }
  private current(owner: unknown) { const s = this.job(); if (!s.owner || s.owner !== owner) throw new Error("Stale job owner"); return s; }
  private timeRemaining(s: Job) { return s.request.budget.maxElapsedMs - (Date.now() - s.createdAt); }
  private async source(s: Job, name: string) { const raw = await readFile(join(this.directory,name),"utf8"); if (hash(raw) !== s.sourceDigests[name]) throw new Error("Source changed after admission"); return raw; }
  private async perform(name: string, taskId: string, owner: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const state = this.tx(() => {
      const s = this.current(owner), task = s.plan?.tasks.find(t => t.id === taskId);
      if (s.status !== "running" || !task || task.tool !== name || !s.request.allowedTools.includes(name)) throw new Error("Tool does not match the admitted plan");
      const previous = s.checkpoints.find(c => c.taskId === taskId);
      if (previous?.status === "completed") return { job: s, previous };
      if (previous) throw new Error("Task already claimed");
      if (task.dependsOn.some(id => !s.checkpoints.some(c => c.taskId === id && c.status === "completed"))) throw new Error("Dependencies incomplete");
      const spec = toolSpec(name), b = s.request.budget;
      if (this.timeRemaining(s) <= 0 || s.usage.toolCalls + 1 > b.maxToolCalls || s.usage.costCents + spec.costCents > b.maxCostCents) throw new Error("Execution budget exhausted");
      const active = s.checkpoints.filter(c => c.status === "running").map(c => toolSpec(s.plan!.tasks.find(t => t.id === c.taskId)!.tool));
      if (active.length >= b.concurrency || active.reduce((n,t) => n + t.memoryUnits,0) + spec.memoryUnits > b.memoryUnits || active.filter(t => t.resource === spec.resource).length >= (spec.resource === "io" ? b.ioSlots : b.cpuSlots)) throw new Error("Execution resource capacity exhausted");
      s.usage.toolCalls++; s.usage.costCents += spec.costCents;
      s.checkpoints.push({ taskId, status: "running", output: null }); this.save(s, `task-start:${taskId}`); return { job: s, previous: null };
    });
    if (state.previous) return state.previous.output;
    const s = state.job, spec = toolSpec(name);
    const dependency = (role: Role) => {
      const task = s.plan!.tasks.find(t => t.role === role)!;
      const checkpoint = s.checkpoints.find(c => c.taskId === task.id && c.status === "completed");
      if (!checkpoint) throw new Error("Missing prerequisite output"); return checkpoint.output;
    };
    let output: unknown;
    if (spec.role === "sales") {
      const raw = await this.source(s, `sales.${s.request.salesFormat}`);
      let values: unknown;
      if (name === "planning_sales_json") values = JSON.parse(raw);
      else {
        const lines = raw.trim().split(/\r?\n/); if (lines.shift() !== "sku,day,quantity") throw new Error("Invalid sales CSV header");
        const grouped = new Map<string, Map<number,number>>();
        for (const line of lines) { const cells = line.split(","); if (cells.length !== 3) throw new Error("Invalid sales CSV row"); const sku = text(cells[0],64), day = integer(Number(cells[1]),1,30), quantity = integer(Number(cells[2]),0,100000); const days = grouped.get(sku) ?? new Map<number,number>(); if (days.has(day)) throw new Error("Duplicate sales day"); days.set(day,quantity); grouped.set(sku,days); }
        values = [...grouped].map(([sku,days]) => { const sorted = [...days].sort((a,b)=>a[0]-b[0]); if (sorted.some(([day],i)=>day!==i+1)) throw new Error("Noncontiguous sales days"); return { sku, daily: sorted.map(x=>x[1]) }; });
      }
      if (!Array.isArray(values) || !values.length || values.length > 100) throw new Error("Invalid sales data");
      output = values.map(value => { const row = object(value); if (!Array.isArray(row.daily) || !row.daily.length || row.daily.length > 30) throw new Error("Invalid daily sales"); return { sku: text(row.sku,64), daily: row.daily.map(n=>integer(n,0,100000)) }; });
    } else if (spec.role === "stock") {
      const values: unknown = JSON.parse(await this.source(s,"stock.json")); if (!Array.isArray(values) || !values.length || values.length > 100) throw new Error("Invalid stock");
      output = values.map(value => { const row = object(value); return { sku: text(row.sku,64), available: integer(row.available,0,10000000) }; });
    } else if (spec.role === "demand") {
      output = (dependency("sales") as { sku: string; daily: number[] }[]).map(row => ({ sku: row.sku, dailyDemand: name === "planning_demand_basic" ? row.daily.reduce((n,v)=>n+v,0)/row.daily.length : Math.max(...row.daily) }));
    } else if (spec.role === "replenish") {
      const stock = dependency("stock") as {sku:string;available:number}[], demand = dependency("demand") as {sku:string;dailyDemand:number}[];
      if (stock.length !== demand.length || demand.some(row=>!stock.some(x=>x.sku===row.sku))) throw new Error("Sales and inventory SKU sets differ");
      output = demand.map(row => { const available = stock.find(x=>x.sku===row.sku)!.available; return { ...row, available, quantity: Math.max(0,Math.ceil(row.dailyDemand*s.request.horizonDays)-available) }; });
    } else output = dependency("replenish");
    if (Array.isArray(output) && new Set(output.map(row=>(row as {sku:string}).sku)).size !== output.length) throw new Error("Duplicate SKU");
    signal?.throwIfAborted();
    return this.tx(() => {
      const latest = this.current(owner); if (latest.status !== "running" || this.timeRemaining(latest) <= 0) throw new Error("Execution stopped or deadline exceeded");
      const checkpoint = latest.checkpoints.find(c=>c.taskId===taskId)!; checkpoint.status = "completed"; checkpoint.output = output;
      if (spec.role === "report") latest.rows = output as Row[];
      this.save(latest, `task-complete:${taskId}`); return output;
    });
  }
  private async export(s: Job) {
    await mkdir(join(this.directory,"artifacts"),{recursive:true});
    if (s.plan) await immutable(join(this.directory,"artifacts/plan.json"),JSON.stringify({plan:s.plan,schedule:s.schedule},null,2)+"\n");
    if (s.rows && s.status === "completed") {
      await immutable(join(this.directory,"artifacts/replenishment.json"),JSON.stringify({goal:s.request.goal,horizonDays:s.request.horizonDays,rows:s.rows},null,2)+"\n");
      await immutable(join(this.directory,"artifacts/replenishment.md"),`# Replenishment report\n\n${s.request.goal}\n\n| SKU | Daily demand | Available | Replenish |\n| --- | ---: | ---: | ---: |\n`+s.rows.map(r=>`| ${r.sku} | ${r.dailyDemand} | ${r.available} | ${r.quantity} |`).join("\n")+"\n");
    }
  }
  get tools(): RegisteredTool[] {
    const tool = (name:string,execute:RegisteredTool["execute"]):RegisteredTool => ({name,effects:["read","write"],inputSchema:{type:"object"},validate(args){object(args);},execute});
    const ok = (value:unknown)=>({status:"success" as const,structuredContent:json({value})});
    return [
      tool("planning_read",async()=>ok(this.job())),
      tool("planning_claim",async()=>ok(this.tx(()=>{const s=this.job();if(s.status!=="received")return {claimed:false,job:s};const reason=preflight(s.request);if(reason||this.timeRemaining(s)<=0||s.usage.modelCalls>=s.request.budget.maxModelCalls||s.usage.costCents+modelCostCents>s.request.budget.maxCostCents){s.status="blocked";s.reason=reason??"MODEL_OR_TIME_BUDGET";}else{s.status="planning";s.owner=randomUUID();s.usage.modelCalls++;s.usage.costCents+=modelCostCents;}this.save(s,"planning-admission");return {claimed:s.status==="planning",job:s};}))),
      tool("planning_accept",async args=>ok(this.tx(()=>{const s=this.current(args.owner);if(s.status!=="planning")throw new Error("Stale planning result");const result=validatePlan(args.plan,s.request);if(this.timeRemaining(s)<result.schedule.estimatedMs-modelEstimateMs)throw new Error("Time budget exhausted during planning");s.plan=result.plan;s.schedule=result.schedule;s.status="planned";s.owner=null;this.save(s,"plan-accepted");return s;}))),
      tool("planning_archived",async args=>ok(this.tx(()=>{const s=this.job();if(args.kind==="plan"&&s.plan)s.planArchived=true;else if(args.kind==="result"&&s.delivered&&s.status==="completed")s.resultArchived=true;else throw new Error("Invalid archive acknowledgement");this.save(s,"memory-archived");return s;}))),
      tool("planning_begin",async()=>ok(this.tx(()=>{
        const s=this.job();if(s.status!=="planned")return {claimed:false,job:s};if(!s.planArchived)throw new Error("Plan must be in MEMORY before execution");
        const pending=s.plan!.tasks.filter(t=>!s.checkpoints.some(c=>c.taskId===t.id&&c.status==="completed")),b=s.request.budget;
        if(s.usage.toolCalls+pending.length>b.maxToolCalls||s.usage.costCents+pending.reduce((n,t)=>n+toolSpec(t.tool).costCents,0)>b.maxCostCents||this.timeRemaining(s)<=0){s.status="blocked";s.reason="EXECUTION_BUDGET";s.delivered=false;this.save(s,"execution-budget-blocked");return {claimed:false,job:s};}
        s.status="running";s.owner=randomUUID();s.delivered=false;this.save(s,"execution-started");return {claimed:true,job:s};
      }))),
      tool("planning_finish",async args=>ok(this.tx(()=>{const s=this.current(args.owner);if(s.status!=="running"||!s.rows||s.checkpoints.length!==5||s.checkpoints.some(c=>c.status!=="completed"))throw new Error("Incomplete task execution");s.status="completed";s.owner=null;this.save(s,"completed");return s;}))),
      tool("planning_fail",async args=>ok(this.tx(()=>{const s=this.job();if(s.owner===args.owner){s.status=args.cancelled?"cancelled":"failed";s.reason=text(args.reason);s.owner=null;this.save(s,"execution-failed");}return s;}))),
      tool("planning_view",async()=>{const s=this.job();await this.export(s);return ok({namespace:s.namespace,status:s.status,reason:s.reason,goal:s.request.goal,plan:s.plan,schedule:s.schedule,usage:s.usage,rows:s.rows});}),
      tool("planning_snapshot",async()=>{const s=this.job();await this.export(s);const dir=join(this.directory,"results");await mkdir(dir,{recursive:true});const path=join(dir,"job.json"),tmp=`${path}.${randomUUID()}.tmp`;try{await writeFile(tmp,JSON.stringify(s,null,2));await rename(tmp,path);}finally{await rm(tmp,{force:true});}return ok(s);}),
      ...catalog.map(spec=>tool(spec.name,async(args,context)=>ok(await this.perform(spec.name,text(args.taskId,64),args.owner,context.signal)))),
    ];
  }
  readonly output: OutputSink = { deliver: async input => {
    const s=this.job(), value=object(input.message.content);
    if(value.namespace!==s.namespace||value.status!==s.status||input.deliveryId!==`${s.namespace}:${s.status}:${s.usage.toolCalls}:${s.usage.modelCalls}`)throw new Error("Stale task response");
    const dir=join(this.directory,"inbox");await mkdir(dir,{recursive:true});const path=join(dir,`${s.status}-${s.usage.toolCalls}-${s.usage.modelCalls}.json`);
    await immutable(path,JSON.stringify(value,null,2)+"\n");
    this.tx(()=>{const latest=this.job();if(latest.status!==s.status||latest.usage.toolCalls!==s.usage.toolCalls)throw new Error("Task changed during delivery");latest.delivered=true;this.save(latest,"delivered");});
    return {deliveryId:input.deliveryId,status:"accepted",artifacts:[{name:"task-response.json",reference:{uri:pathToFileURL(path).href,mediaType:"application/json"}}]};
  } };
  close(){this.db.close();}
}
