import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile, type RuntimeConfig } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "../../_shared/tools/storage/workers.ts";
import { contextTools } from "../../_shared/tools/context/adapters.ts";
import { request, type Request, type Mode } from "../../_shared/tools/context/domain.ts";
import { createFixture, serveFixture } from "./fixtures.ts";
import { runContext, seedConversation } from "./shared.ts";
export const isMain = (url: string) => !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
export const sandbox = (config: RuntimeConfig, r: Request) => ({ ...config.sandbox, tools: ["context_document", "context_search", "context_publish"], network: [...(config.sandbox?.network ?? []), new URL(r.searchUrl).origin] });
export async function runCli(mode: Mode) {
  const { values } = parseArgs({ options: { directory: { type: "string" }, provider: { type: "string" }, checkpoint: { type: "boolean" }, "serve-fixture": { type: "boolean" } } });
  const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider]) throw new Error("Configure a model provider"); const model = config.providers[provider].model ?? config.model?.model; if (!model) throw new Error("Configure a model");
  await mkdir(".examples-context-tasks", { recursive: true }); const directory = values.directory ? resolve(values.directory) : await mkdtemp(resolve(".examples-context-tasks/cli-"));
  const fixture = values.directory ? undefined : await createFixture(directory, mode), r = request(fixture?.request ?? JSON.parse(await readFile(join(directory, "request.json"), "utf8")));
  if (r.mode !== mode) { await fixture?.server.close(); throw new Error("Request mode mismatch"); }
  const server = fixture?.server ?? (values["serve-fixture"] ? await serveFixture(directory, Number(new URL(r.searchUrl).port)) : undefined);
  try { const storage = await openAgentStorage(directory, config);
    try { const runtime = createDitto({ config, sandbox: sandbox(config, r), workers: [...storage.workers, createInferWorker(), createInteractionWorker({ tools: contextTools(directory, r) })] });
      const controller = new AbortController(), cancel = () => controller.abort(); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
      try { if (fixture) await seedConversation(runtime, r, fixture.turns); const result = await runContext(runtime, { request: r, model: { provider, model } }, { signal: controller.signal, ...(values.checkpoint ? { stopAfter: "ready" } : {}) }); console.log(JSON.stringify({ directory, result }, null, 2)); }
      finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); await runtime.close(); }
    } finally { await storage.close(); }
  } finally { await server?.close(); }
}
