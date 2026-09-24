import { limitCapabilityCases } from "./lib/capability-cases.ts";
/** Real models, Redis, database Memory, file tools and complete replenishment tasks. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir,mkdtemp,readFile,writeFile,rm } from "node:fs/promises";
import { join,resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createDitto,loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { contextScopeKey } from "@codesoul-co/ditto/worker/context";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "../examples/_shared/tools/storage/workers.ts";
import { PlanningStore,type Status,type Job } from "../examples/_shared/tools/planning-store.ts";
import { type Mode,type Request } from "../examples/_shared/tools/planning-domain.ts";
import { createFixture } from "../examples/capabilities/planning/fixtures.ts";
import { runPlanning,report,prepareContext,scope,memoryKey } from "../examples/capabilities/planning/shared.ts";
const{values}=parseArgs({options:{provider:{type:"string"},report:{type:"string",default:".examples-planning-tasks-live-results.json"},"output-dir":{type:"string",default:".examples-planning-tasks"}}});
const config=loadRuntimeConfigFile("ditto.yaml",process.env),provider=values.provider??config.model?.provider;
assert.ok(provider&&config.providers[provider]);const model=config.providers[provider].model??config.model?.model;assert.ok(model);
const scenarios:{name:string;mode:Mode;status:Status;calls:number}[]=[
 ...(["plan","decompose","dependencies","budget","tools"] as const).map(mode=>({name:`${mode}-complete-task`,mode,status:"completed" as const,calls:1})),
 {name:"tight-cost-selects-basic",mode:"budget",status:"completed",calls:1},
 {name:"single-resource-schedule",mode:"dependencies",status:"completed",calls:1},
 {name:"csv-only-tool-allowlist",mode:"tools",status:"completed",calls:1},
 ...["model-budget-zero","tool-budget-too-small","cost-budget-too-small","time-budget-too-small","resource-capacity-zero","missing-required-tool"].map(name=>({name,mode:"budget" as const,status:"blocked" as const,calls:0})),
 {name:"source-drift-blocks-task",mode:"plan",status:"failed",calls:1},
 {name:"invalid-source-data",mode:"tools",status:"failed",calls:1},
 {name:"plan-process-crash-resume",mode:"plan",status:"completed",calls:1},
 {name:"task-process-crash-resume",mode:"decompose",status:"completed",calls:1},
 {name:"redis-expiry-memory-restore",mode:"plan",status:"completed",calls:1},
 {name:"redis-unavailable-before-inference",mode:"plan",status:"completed",calls:1},
 {name:"memory-unavailable-before-inference",mode:"plan",status:"completed",calls:1},
 {name:"plan-memory-write-retry",mode:"plan",status:"completed",calls:1},
 {name:"result-memory-commit-crash",mode:"plan",status:"completed",calls:1},
 {name:"retry-exhausts-call-budget",mode:"budget",status:"blocked",calls:1},
 {name:"file-tool-failure-retry",mode:"plan",status:"completed",calls:1},
 {name:"delivery-failure-retry",mode:"plan",status:"completed",calls:1},
 {name:"cancel-before-inference",mode:"plan",status:"cancelled",calls:0},
 {name:"execution-time-limit",mode:"budget",status:"failed",calls:1},
 {name:"invalid-dependency-proposal",mode:"dependencies",status:"failed",calls:1},
];
limitCapabilityCases(scenarios);
await mkdir(resolve(values["output-dir"]!),{recursive:true});const directory=await mkdtemp(join(resolve(values["output-dir"]!),"run-"));
const results:Record<string,unknown>[]=[];const startedAt=new Date().toISOString();
for(const scenario of scenarios){
 console.log(JSON.stringify({name:scenario.name,event:"started"}));const dir=join(directory,scenario.name);await mkdir(dir);
 const fixture=await createFixture(dir,scenario.mode),request:Request=fixture.request;
 if(scenario.name==="tight-cost-selects-basic")request.budget.maxCostCents=36;
 if(scenario.name==="single-resource-schedule"){request.budget.concurrency=1;request.budget.ioSlots=1;request.budget.memoryUnits=1;}
 if(scenario.name==="csv-only-tool-allowlist")request.allowedTools=request.allowedTools.filter(x=>x!=="planning_sales_json");
 if(scenario.name==="retry-exhausts-call-budget")request.budget.maxToolCalls=5;
 if(scenario.name==="model-budget-zero")request.budget.maxModelCalls=0;
 if(scenario.name==="tool-budget-too-small")request.budget.maxToolCalls=4;
 if(scenario.name==="cost-budget-too-small")request.budget.maxCostCents=35;
 if(scenario.name==="time-budget-too-small")request.budget.maxElapsedMs=2000;
 if(scenario.name==="resource-capacity-zero")request.budget.cpuSlots=0;
 if(scenario.name==="missing-required-tool")request.allowedTools=request.allowedTools.filter(x=>x!=="planning_stock");
 if(scenario.name==="execution-time-limit")request.budget.maxElapsedMs=2200;
 if(scenario.name==="invalid-source-data")await writeFile(join(dir,"sales.csv"),"sku,day,quantity\nwrong,1,invalid\n");
 await writeFile(join(dir,"request.json"),JSON.stringify(request,null,2));
 let store=new PlanningStore(dir);await store.create(scenario.mode);let storage=await openAgentStorage(dir,config);
 const spans:Record<string,unknown>[]=[],children:Record<string,unknown>[]=[];
 let afterSample:((value:unknown)=>Promise<unknown>)|undefined;
 function observed(definition:WorkerDefinition):WorkerDefinition{return{...definition,instantiate(){const worker=definition.instantiate();return{async execute(node,args,context){const span:Record<string,unknown>={node,...context.execution,start:Date.now()};spans.push(span);try{let value=await worker.execute(node,args,context);if(node==="INFER.REASONING.SAMPLE"){span.original=value;if(afterSample)value=await afterSample(value);span.result=value;}return value;}finally{span.end=Date.now();}},async dispose(){await worker.dispose?.();}};}};}
 const open=()=>createDitto({config,sandbox:{...config.sandbox,tools:store.tools.map(t=>t.name)},workers:[...storage.workers.map(observed),observed(createInferWorker()),observed(createInteractionWorker({tools:store.tools,output:store.output}))]});
 let runtime=open();const run=(planOnly=false):Promise<Job>=>runPlanning(runtime,{model:{provider,model}},scenario.mode,{planOnly});
 const reopen=async()=>{await runtime.close();await storage.close();store.close();store=new PlanningStore(dir);storage=await openAgentStorage(dir,config);runtime=open();};
 const calls=()=>spans.filter(s=>s.node==="INFER.REASONING.SAMPLE").length+children.reduce((n,c)=>n+Number(c.modelCalls),0);
 async function child(phase:string){await new Promise<void>((done,reject)=>{const proc=spawn(process.execPath,["scripts/fixtures/planning-child.ts","--directory",dir,"--phase",phase,"--provider",provider!],{env:process.env,stdio:["ignore","ignore","pipe"]});let error="";proc.stderr.on("data",x=>{error+=String(x);});proc.once("error",reject);proc.once("exit",(code,signal)=>phase.endsWith("crash")?signal==="SIGKILL"?done():reject(new Error(error)):code===0?done():reject(new Error(error)));});const saved=JSON.parse(await readFile(join(dir,`child-${phase}.json`),"utf8"));children.push(saved);return saved.result;}
 const record:Record<string,unknown>={name:scenario.name,status:"failed",directory:dir};
 try{
  switch(scenario.name){
   case "source-drift-blocks-task":await run(true);await writeFile(join(dir,"stock.json"),"[]");await run();break;
   case "plan-process-crash-resume":assert.equal((await child("plan-crash")).status,"planned");assert.equal((await child("continue")).status,"completed");break;
   case "task-process-crash-resume":{const stopped=await child("task-crash");assert.equal(stopped.status,"running");store.retry(stopped.owner);assert.equal((await child("continue")).status,"completed");break;}
   case "redis-expiry-memory-restore":{const planned=await run(true),key=(config.context.cache?.keyPrefix??"ditto:context:")+contextScopeKey(scope(planned));await storage.redis.pExpire(key,1);await delay(20);assert.equal(await storage.redis.get(key),null);await reopen();const restored=await prepareContext(runtime,store.job());assert.deepEqual(restored.items.find(x=>x.id==="plan")!.content,{plan:planned.plan,schedule:planned.schedule});await run();break;}
   case "redis-unavailable-before-inference":await storage.redis.quit();await assert.rejects(run());assert.equal(calls(),0);assert.equal(store.job().status,"received");await reopen();await run();break;
   case "memory-unavailable-before-inference":{const db=new DatabaseSync(join(dir,"memory.sqlite"));try{db.exec("ALTER TABLE memories RENAME TO missing_memories");await assert.rejects(run(),/MEMORY failed/);assert.equal(calls(),0);db.exec("ALTER TABLE missing_memories RENAME TO memories");}finally{db.close();}await reopen();await run();break;}
   case "plan-memory-write-retry":{const db=new DatabaseSync(join(dir,"memory.sqlite"));try{db.exec("CREATE TRIGGER fail_plan BEFORE INSERT ON memories WHEN NEW.memory_key LIKE '%:plan' BEGIN SELECT RAISE(ABORT,'unavailable'); END");await assert.rejects(run(),/MEMORY failed/);assert.equal(store.job().status,"planned");assert.equal(store.job().usage.toolCalls,0);db.exec("DROP TRIGGER fail_plan");}finally{db.close();}await reopen();await run();break;}
   case "result-memory-commit-crash":assert.equal((await child("memory-crash")).resultArchived,false);assert.equal((await child("continue")).resultArchived,true);break;
   case "retry-exhausts-call-budget":{await run(true);const file=join(dir,"sales.json"),raw=await readFile(file,"utf8");await rm(file);assert.equal((await run()).status,"failed");const used=store.job().usage.toolCalls;await writeFile(file,raw);store.retry();assert.equal((await run()).reason,"EXECUTION_BUDGET");assert.equal(store.job().usage.toolCalls,used);break;}
   case "file-tool-failure-retry":{await run(true);const file=join(dir,"sales.json"),raw=await readFile(file,"utf8");await rm(file);assert.equal((await run()).status,"failed");await writeFile(file,raw);await reopen();store.retry();await run();assert.equal(store.job().usage.toolCalls,6);break;}
   case "delivery-failure-retry":await writeFile(join(dir,"inbox"),"blocked-directory");await assert.rejects(run());assert.equal(store.job().status,"completed");await rm(join(dir,"inbox"));await reopen();await run();break;
   case "cancel-before-inference":await runPlanning(runtime,{model:{provider,model}},scenario.mode,{signal:AbortSignal.abort()});break;
   case "invalid-dependency-proposal":afterSample=async value=>{const result=structuredClone(value) as {output:{message:{content:string}}};const plan=JSON.parse(result.output.message.content.trim().replace(/^```(?:json)?\s*/,"").replace(/\s*```$/,""));plan.tasks[0].dependsOn=[plan.tasks[0].id];result.output.message.content=JSON.stringify(plan);return result;};await run();break;
   default:await run();
  }
  const saved=await report(runtime);assert.equal(saved.status,scenario.status);assert.equal(saved.delivered,true);assert.equal(calls(),scenario.calls);
  const allSpans=[...spans,...children.flatMap(c=>c.spans as Record<string,unknown>[])];
  assert.ok(allSpans.some(s=>s.node==="MEMORY.GET"));assert.ok(allSpans.some(s=>s.node==="MEMORY.WRITE"));assert.ok(allSpans.some(s=>s.node==="CONTEXT.LOAD"));
  assert.ok(saved.usage.costCents<=request.budget.maxCostCents);assert.ok(saved.usage.toolCalls<=request.budget.maxToolCalls);assert.ok(saved.usage.modelCalls<=request.budget.maxModelCalls);
  if(saved.status==="completed"){
   assert.equal(saved.checkpoints.filter(x=>x.status==="completed").length,5);assert.ok(saved.planArchived&&saved.resultArchived);
   const basic=saved.plan!.tasks.find(t=>t.role==="demand")!.tool==="planning_demand_basic";
   const expected=fixture.sales.map(row=>{const dailyDemand=basic?row.daily.reduce((n,v)=>n+v,0)/row.daily.length:Math.max(...row.daily),available=fixture.stock.find(x=>x.sku===row.sku)!.available;return{sku:row.sku,dailyDemand,available,quantity:Math.max(0,Math.ceil(dailyDemand*request.horizonDays)-available)};});
   assert.deepEqual(saved.rows,expected);assert.deepEqual(JSON.parse(await readFile(join(dir,"artifacts/replenishment.json"),"utf8")).rows,expected);assert.ok((await readFile(join(dir,"artifacts/replenishment.md"),"utf8")).includes(fixture.sales[0]!.sku));
   if(scenario.name==="tight-cost-selects-basic")assert.equal(basic,true);
   if(scenario.name==="single-resource-schedule")assert.ok(saved.schedule!.waves.every(w=>w.length===1));
   for(const task of saved.plan!.tasks){const completion=store.db.prepare("SELECT seq FROM events WHERE kind=? ORDER BY seq LIMIT 1").get(`task-complete:${task.id}`)!;for(const dependency of task.dependsOn){const before=store.db.prepare("SELECT seq FROM events WHERE kind=? ORDER BY seq LIMIT 1").get(`task-complete:${dependency}`)!;assert.ok(Number(before.seq)<Number(completion.seq));}}
  }else{assert.equal(saved.rows,null);assert.equal(await readFile(join(dir,"artifacts/replenishment.json"),"utf8").then(()=>true,()=>false),false);}
  const key=(config.context.cache?.keyPrefix??"ditto:context:")+contextScopeKey(scope(saved)),cached=JSON.parse((await storage.redis.get(key))!);assert.ok(cached.context.items.some((x:{id:string})=>x.id==="request"));assert.ok(await storage.redis.pTTL(key)>0);
  const db=new DatabaseSync(join(dir,"memory.sqlite"),{readOnly:true});try{const kind=saved.resultArchived?"result":saved.planArchived?"plan":"request";const rows=db.prepare("SELECT content FROM memories WHERE memory_key=?").all(memoryKey(saved,kind));assert.equal(rows.length,1);assert.ok(JSON.parse(String(rows[0]!.content)).items.some((x:{id:string})=>x.id==="request"));record.storage={context:"redis",memory:"sqlite",archiveKey:memoryKey(saved,kind),redisTTL:await storage.redis.pTTL(key)};}finally{db.close();}
  await reopen();assert.deepEqual(await run(),saved);assert.equal(calls(),scenario.calls);record.result=saved;record.status="passed";
 }catch(error){record.error=error instanceof Error?error.message:"Task failed";}
 finally{await runtime.close();await storage.close();store.close();Object.assign(record,{spans,children,modelCalls:calls()});results.push(record);await writeFile(resolve(values.report!),JSON.stringify({startedAt,provider,model,directory,results},null,2));console.log(JSON.stringify({name:scenario.name,status:record.status,modelCalls:record.modelCalls,...(record.error?{error:record.error}:{})}));}
}
const failed=results.filter(r=>r.status!=="passed");console.log(JSON.stringify({passed:results.length-failed.length,total:results.length,modelCalls:results.reduce((n,r)=>n+Number(r.modelCalls),0),directory,report:resolve(values.report!)},null,2));if(failed.length)throw new Error(`${failed.length} planning task experiments failed`);
