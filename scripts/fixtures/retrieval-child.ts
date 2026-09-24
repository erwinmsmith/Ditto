import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createRetrievalWorker } from "@ditto/core/worker/retrieval";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "../../examples/_shared/tools/storage/workers.ts";
import { RetrievalAdapters } from "../../examples/_shared/tools/retrieval/adapters.ts";
import { request } from "../../examples/_shared/tools/retrieval/domain.ts";
import { sandbox } from "../../examples/capabilities/retrieval/cli.ts";
import { runRetrieval } from "../../examples/capabilities/retrieval/shared.ts";
const { values } = parseArgs({ options: { directory: { type: "string" }, phase: { type: "string" }, provider: { type: "string" } } });
const directory = values.directory!, phase = values.phase!;
const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model!.provider!, model = config.providers[provider]!.model ?? config.model!.model!;
const r = request(JSON.parse(await readFile(join(directory, "request.json"), "utf8"))), adapters = new RetrievalAdapters(directory, r), storage = await openAgentStorage(directory, config);
const spans: string[] = [];
const save = async () => writeFile(join(directory, `child-${phase}.json`), JSON.stringify({ spans, modelCalls: spans.filter(n => n === "INFER.REASONING.SAMPLE").length }));
function observed(d: WorkerDefinition): WorkerDefinition { return { ...d, instantiate() { const worker = d.instantiate(); return { async execute(node, input, context) {
  spans.push(node); const value = await worker.execute(node, input, context);
  if (node === "MEMORY.WRITE" && phase.endsWith("crash") && JSON.stringify(input).includes(`:${phase.split("-")[0]}"`)) { await save(); process.kill(process.pid, "SIGKILL"); }
  return value;
}, async dispose() { await worker.dispose?.(); } }; } }; }
const runtime = createDitto({ config, sandbox: sandbox(config, r, adapters), workers: [...storage.workers, createInferWorker(), createRetrievalWorker({ providers: adapters.providers }), createInteractionWorker({ tools: adapters.tools })].map(observed) });
try { await runRetrieval(runtime, { request: r, model: { provider, model } }); await save(); }
finally { await runtime.close(); await storage.close(); adapters.close(); }
