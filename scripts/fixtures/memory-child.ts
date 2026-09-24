import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openMemoryStorage } from "../../examples/_shared/tools/memory/storage.ts";
import { memoryTools } from "../../examples/_shared/tools/memory/adapters.ts";
import { request, namespace, preferenceKey } from "../../examples/_shared/tools/memory/domain.ts";
import { sandbox } from "../../examples/capabilities/memory/cli.ts";
import { runMemory } from "../../examples/capabilities/memory/shared.ts";
const { values } = parseArgs({ options: { directory: { type: "string" }, phase: { type: "string" }, provider: { type: "string" } } });
const directory = values.directory!, phase = values.phase!, config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model!.provider!, model = config.providers[provider]!.model ?? config.model!.model!;
const r = request(JSON.parse(await readFile(join(directory, "request.json"), "utf8"))), storage = await openMemoryStorage({ directory, backend: r.backend, namespace: namespace(r), config }), spans: string[] = [];
const save = async () => writeFile(join(directory, `child-${phase}.json`), JSON.stringify({ spans, modelCalls: spans.filter(n => n === "INFER.REASONING.SAMPLE").length, ...(storage.database.stats ? storage.database.stats : {}) }));
function observed(d: WorkerDefinition): WorkerDefinition { return { ...d, instantiate() { const w = d.instantiate(); return { async execute(node, input, context) {
  spans.push(node); const value = await w.execute(node, input, context);
  const crash = phase === "update-crash" ? node === "MEMORY.UPDATE" : phase === "write-crash" ? node === "MEMORY.WRITE" && JSON.stringify(input).includes(preferenceKey(r)) && !JSON.stringify(input).includes("fingerprint") : phase.endsWith("crash") && node === "MEMORY.WRITE" && JSON.stringify(input).includes(`:${phase.split("-")[0]}"`);
  if (crash) { await save(); process.kill(process.pid, "SIGKILL"); }
  return value;
}, async dispose() { await w.dispose?.(); } }; } }; }
const runtime = createDitto({ config, sandbox: sandbox(config), workers: [...storage.workers, createInferWorker(), createInteractionWorker({ tools: memoryTools(directory, namespace(r)) })].map(observed) });
try { await runMemory(runtime, { request: r, model: { provider, model } }); await save(); }
finally { await runtime.close(); await storage.close(); }
