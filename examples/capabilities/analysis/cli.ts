import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile, type RuntimeConfig } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { createRetrievalWorker } from "@ditto/core/worker/retrieval";
import { openAgentStorage } from "../../_shared/tools/storage/workers.ts";
import { importInternalKnowledge } from "../../_shared/tools/retrieval/memory.ts";
import { AnalysisAdapters } from "../../_shared/tools/analysis/adapters.ts";
import { request, type Request, type Mode } from "../../_shared/tools/analysis/domain.ts";
import { createFixture, pythonPath, serveFixture } from "./fixtures.ts";
import { runAnalysis } from "./shared.ts";
export const isMain = (url: string) => !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
export const sandbox = (config: RuntimeConfig, r: Request, adapters: AnalysisAdapters) => ({ ...config.sandbox, tools: adapters.tools.map(t => t.name), network: [...(config.sandbox?.network ?? []), ...r.allowedOrigins] });
export async function runCli(mode: Mode) {
  const { values } = parseArgs({ options: { directory: { type: "string" }, provider: { type: "string" }, "sources-only": { type: "boolean" }, "serve-fixture": { type: "boolean" } } });
  const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider]) throw new Error("Configure a model provider"); const model = config.providers[provider].model ?? config.model?.model; if (!model) throw new Error("Configure a model");
  await mkdir(".examples-analysis-tasks", { recursive: true }); const directory = values.directory ? resolve(values.directory) : await mkdtemp(resolve(".examples-analysis-tasks/cli-"));
  const fixture = values.directory ? undefined : await createFixture(directory, mode), r = request(fixture?.request ?? JSON.parse(await readFile(join(directory, "request.json"), "utf8")));
  if (r.mode !== mode) { await fixture?.server.close(); throw new Error("Request mode mismatch"); }
  const server = fixture?.server ?? (values["serve-fixture"] ? await serveFixture(directory, Number(new URL(r.sources.find(s => s.format === "web")!.locator).port)) : undefined);
  try {
    const storage = await openAgentStorage(directory, config);
    try {
      const adapters = new AnalysisAdapters(directory, r, pythonPath());
      try {
        const runtime = createDitto({ config, sandbox: sandbox(config, r, adapters), workers: [...storage.workers, createInferWorker(), createRetrievalWorker({ providers: adapters.providers }), createInteractionWorker({ tools: adapters.tools })] });
        const controller = new AbortController(), cancel = () => controller.abort(); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
        try { if (fixture) await importInternalKnowledge(runtime, r.tenant, fixture.knowledge); const result = await runAnalysis(runtime, { request: r, model: { provider, model } }, { signal: controller.signal, ...(values["sources-only"] ? { stopAfter: "sources" } : {}) }); console.log(JSON.stringify({ directory, result }, null, 2)); }
        finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); await runtime.close(); }
      } finally { adapters.close(); }
    } finally { await storage.close(); }
  } finally { await server?.close(); }
}
