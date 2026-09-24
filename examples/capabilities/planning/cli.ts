import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "../../_shared/tools/storage/workers.ts";
import { PlanningStore } from "../../_shared/tools/planning-store.ts";
import type { Mode } from "../../_shared/tools/planning-domain.ts";
import { createFixture } from "./fixtures.ts";
import type { Runner,Input,Options } from "./shared.ts";
export const isMain=(url:string)=>!!process.argv[1]&&url===pathToFileURL(process.argv[1]).href;
export async function runCli(run:(runtime:Runner,input:Input,options?:Options)=>Promise<unknown>,mode:Mode){
  const{values}=parseArgs({options:{directory:{type:"string"},provider:{type:"string"},"plan-only":{type:"boolean"},retry:{type:"boolean"},"stopped-owner":{type:"string"}}});
  if((values.retry||values["stopped-owner"])&&!values.directory)throw new Error("Retry requires an existing directory");
  const config=loadRuntimeConfigFile("ditto.yaml",process.env),provider=values.provider??config.model?.provider;
  if(!provider||!config.providers[provider])throw new Error("Configure a model provider");const model=config.providers[provider].model??config.model?.model;if(!model)throw new Error("Configure a model");
  await mkdir(".examples-planning-tasks",{recursive:true});const directory=values.directory?resolve(values.directory):await mkdtemp(resolve(".examples-planning-tasks/cli-"));
  if(!values.directory)await createFixture(directory,mode);
  const storage=await openAgentStorage(directory,config),store=new PlanningStore(directory);
  const runtime=createDitto({config,sandbox:{...config.sandbox,tools:store.tools.map(t=>t.name)},workers:[...storage.workers,createInferWorker(),createInteractionWorker({tools:store.tools,output:store.output})]});
  const controller=new AbortController(),cancel=()=>controller.abort();process.once("SIGINT",cancel);process.once("SIGTERM",cancel);
  try{if(!values.directory)await store.create(mode);if(values.retry)store.retry(values["stopped-owner"]);const result=await run(runtime,{model:{provider,model}},{signal:controller.signal,planOnly:values["plan-only"]??false});console.log(JSON.stringify({directory,result},null,2));}
  finally{process.off("SIGINT",cancel);process.off("SIGTERM",cancel);try{await runtime.close();}finally{try{await storage.close();}finally{store.close();}}}
}
