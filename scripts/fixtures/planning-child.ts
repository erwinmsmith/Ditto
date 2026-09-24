import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDitto,loadRuntimeConfigFile } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "../../examples/_shared/tools/storage/workers.ts";
import { PlanningStore } from "../../examples/_shared/tools/planning-store.ts";
import { runPlanning } from "../../examples/capabilities/planning/shared.ts";
const {values}=parseArgs({options:{directory:{type:"string"},phase:{type:"string"},provider:{type:"string"}}});
if(!values.directory||!values.phase)throw new Error("directory and phase required");
const directory=values.directory,phase=values.phase,config=loadRuntimeConfigFile("ditto.yaml",process.env),provider=values.provider??config.model?.provider;
if(!provider||!config.providers[provider])throw new Error("Configure provider");const model=config.providers[provider].model??config.model?.model;if(!model)throw new Error("Configure model");
const storage=await openAgentStorage(directory,config),store=new PlanningStore(directory),spans:Record<string,unknown>[]=[];
const snapshot=()=>writeFile(join(directory,`child-${phase}.json`),JSON.stringify({pid:process.pid,result:store.job(),spans,modelCalls:spans.filter(s=>s.node==="INFER.REASONING.SAMPLE").length},null,2));
function observed(definition:WorkerDefinition):WorkerDefinition{return{...definition,instantiate(){const worker=definition.instantiate();return{async execute(node,input,context){const span:Record<string,unknown>={node,...context.execution,start:Date.now()};spans.push(span);try{const value=await worker.execute(node,input,context);if(node==="INFER.REASONING.SAMPLE")span.result=value;
 const args=input as {call?:{name?:string};memories?:{key?:string}[]};
 if((phase==="task-crash"&&args.call?.name?.startsWith("planning_sales_"))||(phase==="memory-crash"&&node==="MEMORY.WRITE"&&args.memories?.[0]?.key?.endsWith(":result"))){await snapshot();process.kill(process.pid,"SIGKILL");}return value;
 }finally{span.end=Date.now();}},async dispose(){await worker.dispose?.();}};}};}
const runtime=createDitto({config,sandbox:{...config.sandbox,tools:store.tools.map(t=>t.name)},workers:[...storage.workers.map(observed),observed(createInferWorker()),observed(createInteractionWorker({tools:store.tools,output:store.output}))]});
try{await runPlanning(runtime,{model:{provider,model}},store.job().mode,{planOnly:phase==="plan-crash"});await snapshot();if(phase.endsWith("crash"))process.kill(process.pid,"SIGKILL");}
finally{await runtime.close();await storage.close();store.close();}
