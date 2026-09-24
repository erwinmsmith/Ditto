import assert from "node:assert/strict";
import { mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createDitto } from "@ditto/core/runtime";
import { createContextWorker,createInMemoryContextStore } from "@ditto/core/worker/context";
import { createMemoryWorker } from "@ditto/core/worker/memory";
import { createInferWorker,type SampleInput,type SampleOutput } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openSqliteMemory } from "../examples/_shared/tools/storage/sqlite-memory.ts";
import { PlanningStore } from "../examples/_shared/tools/planning-store.ts";
import { validatePlan,requirements,preflight,type Request,type Plan,type Role,type Mode } from "../examples/_shared/tools/planning-domain.ts";
import { createFixture } from "../examples/capabilities/planning/fixtures.ts";
import { runPlanning,prepareContext,action } from "../examples/capabilities/planning/shared.ts";
function candidate(request:Request,quality="detailed"):Plan{return{goal:request.goal,tasks:(Object.keys(requirements) as Role[]).map(role=>({id:role,role,tool:role==="sales"?`planning_sales_${request.salesFormat}`:role==="demand"?`planning_demand_${quality}`:`planning_${role}`,dependsOn:requirements[role],reason:`Compute ${role}`}))};}
function answer(input:SampleInput){const items=JSON.parse(String(input.messages[1]!.content)) as {id:string;content:Request}[];const request=items.find(x=>x.id==="request")!.content;for(const quality of request.analysis==="basic"?["basic"]:["detailed","basic"]){const plan=candidate(request,quality);try{validatePlan(plan,request);return plan;}catch{}}throw new Error("No allowed plan");}
async function setup(mode:Mode="plan",change:Partial<Request>={},invoke?:(input:SampleInput)=>Promise<SampleOutput>){
 const directory=await mkdtemp(join(tmpdir(),"ditto-plan-test-")),fixture=await createFixture(directory,mode,change);
 let store=new PlanningStore(directory),memory=openSqliteMemory(join(directory,"memory.sqlite")),calls=0,failDelivery=false;
 const open=()=>createDitto({sandbox:{tools:store.tools.map(t=>t.name)},workers:[createContextWorker({services:{stateStore:createInMemoryContextStore()}}),createMemoryWorker({store:memory.store}),createInferWorker({providers:{unit:{async invoke(input){calls++;return invoke?invoke(input):{message:{role:"assistant",content:JSON.stringify(answer(input))},finishReason:"stop"};}}}}),createInteractionWorker({tools:store.tools,output:{deliver:(input,context)=>{if(failDelivery)throw new Error("Delivery unavailable");return store.output.deliver(input,context);}}})]});
 let runtime=open();await store.create(mode);
 return{...fixture,directory,get store(){return store;},get runtime(){return runtime;},calls:()=>calls,failDelivery(value:boolean){failDelivery=value;},run:(planOnly=false,signal?:AbortSignal)=>runPlanning(runtime,{model:{provider:"unit",model:"unit"}},mode,{planOnly,...(signal?{signal}:{})}),async reopen(){await runtime.close();await memory.close();store.close();store=new PlanningStore(directory);memory=openSqliteMemory(join(directory,"memory.sqlite"));runtime=open();},async close(){await runtime.close();await memory.close();store.close();await rm(directory,{recursive:true,force:true});}};
}
test("five planning entries execute actual tasks and persist Redis-contract Context plus database MEMORY",async()=>{
 for(const mode of ["plan","decompose","dependencies","budget","tools"] as const){const s=await setup(mode);try{const done=await s.run();assert.equal(done.status,"completed");assert.equal(done.plan!.tasks.length,5);assert.equal(done.rows![0]!.quantity,22);assert.equal(done.rows![1]!.quantity,0);assert.equal(done.usage.toolCalls,5);assert.equal(done.planArchived,true);assert.equal(done.resultArchived,true);assert.equal(done.delivered,true);assert.deepEqual(JSON.parse(await readFile(join(s.directory,"artifacts/replenishment.json"),"utf8")).rows,done.rows);await s.reopen();assert.deepEqual(await s.run(),done);assert.equal(s.calls(),1);assert.ok((await prepareContext(s.runtime,done)).items.some(x=>x.id==="result"));}finally{await s.close();}}
});
test("dependencies are sorted for execution and invalid model plans cannot bypass contracts",async()=>{
 const s=await setup();try{const base=candidate(s.request);assert.equal(validatePlan({...base,tasks:[...base.tasks].reverse()},s.request).schedule.waves.length,4);
 for(const mutate of [(p:Plan)=>{p.tasks[0]!.dependsOn=["report"];},(p:Plan)=>{p.tasks[2]!.dependsOn=["alien"];},(p:Plan)=>{p.tasks[4]!.dependsOn=[];},(p:Plan)=>{p.tasks[0]!.id="report";},(p:Plan)=>{p.tasks[0]!.tool="shell_execute";},(p:Plan)=>{p.tasks.pop();},(p:Plan)=>{p.tasks[0]!.tool="planning_sales_csv";}]){const p=structuredClone(base);mutate(p);assert.throws(()=>validatePlan(p,s.request));}
 }finally{await s.close();}
});
test("budget admission covers model calls, tool calls, cost, time, and resource capacity",async()=>{
 const s=await setup();try{for(const budget of [{...s.request.budget,maxModelCalls:0},{...s.request.budget,maxToolCalls:4},{...s.request.budget,maxCostCents:35},{...s.request.budget,maxElapsedMs:2000},{...s.request.budget,ioSlots:0},{...s.request.budget,cpuSlots:0},{...s.request.budget,memoryUnits:0}])assert.ok(preflight({...s.request,budget}));const capped={...s.request,budget:{...s.request.budget,maxCostCents:36,memoryUnits:1,ioSlots:1}};assert.equal(preflight(capped),null);const checked=validatePlan(candidate(capped,"basic"),capped);assert.equal(checked.schedule.costCents,36);assert.equal(checked.schedule.waves[0]!.length,1);assert.equal(checked.schedule.peakMemoryUnits,1);assert.throws(()=>validatePlan(candidate(capped,"detailed"),capped));}finally{await s.close();}
});
test("plan-only can resume with a fresh Context cache and without replanning",async()=>{
 const s=await setup();try{const planned=await s.run(true);assert.equal(planned.status,"planned");assert.equal(planned.usage.toolCalls,0);await s.reopen();assert.deepEqual((await prepareContext(s.runtime,planned)).items.find(x=>x.id==="plan")!.content,{plan:planned.plan,schedule:planned.schedule});assert.equal((await s.run()).status,"completed");assert.equal(s.calls(),1);}finally{await s.close();}
});
test("tool failures preserve successful checkpoints and retry charges only unfinished work",async()=>{
 const s=await setup();try{await s.run(true);const file=join(s.directory,"sales.json"),raw=await readFile(file,"utf8");await rm(file);const failed=await s.run();assert.equal(failed.status,"failed");assert.equal(failed.rows,null);assert.ok(failed.checkpoints.some(c=>c.taskId==="stock"&&c.status==="completed"));await writeFile(file,raw);await s.reopen();s.store.retry();const done=await s.run();assert.equal(done.status,"completed");assert.equal(done.usage.toolCalls,6);assert.equal(s.calls(),1);}finally{await s.close();}
});
test("invalid and truncated model output does not execute business tools",async()=>{
 for(const kind of ["cycle","json","truncated"]){const s=await setup("plan",{},async input=>{const plan=answer(input);if(kind==="cycle")plan.tasks[0]!.dependsOn=["report"];return{message:{role:"assistant",content:kind==="json"?"{}":JSON.stringify(plan)},finishReason:kind==="truncated"?"length":"stop"};});try{const result=await s.run();assert.equal(result.status,"failed");assert.equal(result.usage.toolCalls,0);assert.equal(result.rows,null);}finally{await s.close();}}
});
test("pre-cancellation stops inference and execution, while a completed job remains replayable",async()=>{
 const s=await setup();try{const result=await s.run(false,AbortSignal.abort());assert.equal(result.status,"cancelled");assert.equal(s.calls(),0);assert.equal(result.usage.toolCalls,0);}finally{await s.close();}
});
test("failed Memory archive stops execution and can be repaired without a second model call",async()=>{
 const s=await setup();const database=new DatabaseSync(join(s.directory,"memory.sqlite"));try{database.exec("CREATE TRIGGER fail_plan_memory BEFORE INSERT ON memories WHEN NEW.memory_key LIKE '%:plan' BEGIN SELECT RAISE(ABORT,'unavailable'); END");await assert.rejects(s.run(),/MEMORY failed/);assert.equal(s.store.job().status,"planned");assert.equal(s.store.job().usage.toolCalls,0);database.exec("DROP TRIGGER fail_plan_memory");await s.reopen();const result=await s.run();assert.equal(result.status,"completed");assert.equal(s.calls(),1);}finally{database.close();await s.close();}
});
test("delivery failures retry presentation without repeating business tools",async()=>{
 const s=await setup();try{s.failDelivery(true);await assert.rejects(s.run());assert.equal(s.store.job().status,"completed");s.failDelivery(false);await s.reopen();const done=await s.run();assert.equal(done.resultArchived,true);assert.equal(done.usage.toolCalls,5);assert.equal(s.calls(),1);}finally{await s.close();}
});
test("an active job cannot be stolen, and tools cannot be swapped after admission",async()=>{
 const s=await setup();try{await s.run(true);const started=await action<{job:{owner:string}}>(s.runtime,"planning_begin");assert.equal((await s.run()).status,"running");assert.throws(()=>s.store.retry("another-owner"));await assert.rejects(action(s.runtime,"planning_sales_csv",{owner:started.job.owner,taskId:"sales"}));}finally{await s.close();}
});
test("planning sources and adapters only import public Core entries",async()=>{
 const{auditSource,sourceFiles}=await import("../scripts/lib/control-flow-boundary.ts");const manifest=JSON.parse(await readFile(join(process.cwd(),"package.json"),"utf8"));const entries=Object.keys(manifest.exports).map(key=>key==="."?manifest.name:manifest.name+key.slice(1));
 for(const file of [...await sourceFiles(join(process.cwd(),"examples/capabilities/planning")),join(process.cwd(),"examples/_shared/tools/planning-store.ts"),join(process.cwd(),"examples/_shared/tools/planning-domain.ts"),...await sourceFiles(join(process.cwd(),"examples/_shared/tools/storage"))])auditSource(await readFile(file,"utf8"),file,entries);
});


test("retry admission checks remaining budget before any additional tools run",async()=>{
 const original=await setup();const budget={...original.request.budget,maxToolCalls:5};await original.close();
 const s=await setup("budget",{budget});try{await s.run(true);const file=join(s.directory,"sales.json"),raw=await readFile(file,"utf8");await rm(file);assert.equal((await s.run()).status,"failed");const used=s.store.job().usage.toolCalls;await writeFile(file,raw);s.store.retry();const blocked=await s.run();assert.equal(blocked.status,"blocked");assert.equal(blocked.reason,"EXECUTION_BUDGET");assert.equal(blocked.usage.toolCalls,used);assert.equal(blocked.rows,null);}finally{await s.close();}
});
