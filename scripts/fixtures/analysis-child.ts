import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createRetrievalWorker } from "@codesoul-co/ditto-retrieval";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "../../examples/_shared/tools/storage/workers.ts";
import { AnalysisAdapters } from "../../examples/_shared/tools/analysis/adapters.ts";
import { request } from "../../examples/_shared/tools/analysis/domain.ts";
import { pythonPath } from "../../examples/capabilities/analysis/fixtures.ts";
import { sandbox } from "../../examples/capabilities/analysis/cli.ts";
import { runAnalysis } from "../../examples/capabilities/analysis/shared.ts";
const { values } = parseArgs({ options: { directory: { type: "string" }, phase: { type: "string" }, provider: { type: "string" } } });
const directory = values.directory!, phase = values.phase!;
const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model!.provider!, model = config.providers[provider]!.model ?? config.model!.model!;
const r = request(JSON.parse(await readFile(join(directory, "request.json"), "utf8"))), adapters = new AnalysisAdapters(directory, r, pythonPath()), storage = await openAgentStorage(directory, config);
const spans: string[] = [];
const save = async () => writeFile(join(directory, `child-${phase}.json`), JSON.stringify({ spans, modelCalls: spans.filter(n => n === "INFER.REASONING.SAMPLE").length }));
function observed(d: WorkerDefinition): WorkerDefinition { return { ...d, instantiate() { const worker = d.instantiate(); return { async execute(node, input, context) {
  spans.push(node); const value = await worker.execute(node, input, context);
  if (node === "MEMORY.WRITE" && phase.endsWith("crash") && JSON.stringify(input).includes(`:${phase.split("-")[0]}"`)) { await save(); process.kill(process.pid, "SIGKILL"); }
  return value;
}, async dispose() { await worker.dispose?.(); } }; } }; }
const runtime = createDitto({ config, sandbox: sandbox(config, r, adapters), workers: [...storage.workers, createInferWorker(), createRetrievalWorker({ providers: adapters.providers }), createInteractionWorker({ tools: adapters.tools })].map(observed) });
try { await runAnalysis(runtime, { request: r, model: { provider, model } }); await save(); }
finally { await runtime.close(); await storage.close(); adapters.close(); }
