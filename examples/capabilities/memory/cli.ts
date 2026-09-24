import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile, type RuntimeConfig } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openMemoryStorage } from "../../_shared/tools/memory/storage.ts";
import { memoryTools } from "../../_shared/tools/memory/adapters.ts";
import { request, namespace, backends, type Backend, type Mode } from "../../_shared/tools/memory/domain.ts";
import { createFixture } from "./fixtures.ts";
import { runMemory, writeMemories } from "./shared.ts";
export const isMain = (url: string) => !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
export const sandbox = (config: RuntimeConfig) => ({ ...config.sandbox, tools: ["memory_project", "memory_publish"] });
export async function runCli(mode: Mode) {
  const { values } = parseArgs({ options: { directory: { type: "string" }, backend: { type: "string" }, provider: { type: "string" }, checkpoint: { type: "boolean" } } });
  const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider]) throw new Error("Configure a model provider"); const model = config.providers[provider].model ?? config.model?.model; if (!model) throw new Error("Configure a model");
  const backend = (values.backend ?? "sqlite") as Backend; if (!backends.includes(backend)) throw new Error("Choose sqlite, postgres or qdrant");
  await mkdir(".examples-memory-tasks", { recursive: true }); const directory = values.directory ? resolve(values.directory) : await mkdtemp(resolve(".examples-memory-tasks/cli-"));
  const fixture = values.directory ? undefined : await createFixture(directory, mode, backend), r = request(fixture?.request ?? JSON.parse(await readFile(join(directory, "request.json"), "utf8")));
  if (r.mode !== mode || values.backend && r.backend !== values.backend) throw new Error("Request mode/backend mismatch");
  const storage = await openMemoryStorage({ directory, namespace: namespace(r), backend: r.backend, config });
  try { const runtime = createDitto({ config, sandbox: sandbox(config), workers: [...storage.workers, createInferWorker(), createInteractionWorker({ tools: memoryTools(directory, namespace(r)) })] });
    const controller = new AbortController(), cancel = () => controller.abort(); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    try { if (fixture) await writeMemories(runtime, fixture.memories); const result = await runMemory(runtime, { request: r, model: { provider, model } }, { signal: controller.signal, ...(values.checkpoint ? { stopAfter: "progress" } : {}) }); console.log(JSON.stringify({ directory, result }, null, 2)); }
    finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); await runtime.close(); }
  } finally { await storage.close(); }
}
