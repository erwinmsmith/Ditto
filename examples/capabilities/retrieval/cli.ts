import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile, type RuntimeConfig } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { createRetrievalWorker } from "@codesoul-co/ditto-retrieval";
import { openAgentStorage } from "../../_shared/tools/storage/workers.ts";
import { RetrievalAdapters } from "../../_shared/tools/retrieval/adapters.ts";
import { request, type Mode, type Request } from "../../_shared/tools/retrieval/domain.ts";
import { createFixture } from "./fixtures.ts";
import { importInternalKnowledge } from "../../_shared/tools/retrieval/memory.ts";
import { runRetrieval } from "./shared.ts";
export const isMain = (url: string) => !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
export const sandbox = (config: RuntimeConfig, r: Request, adapters: RetrievalAdapters) => ({ ...config.sandbox, tools: adapters.tools.map(t => t.name), network: [...(config.sandbox?.network ?? []), ...r.allowedOrigins, r.searchEngine === "brave" ? "https://api.search.brave.com" : "https://en.wikipedia.org"] });
export async function runCli(mode: Mode) {
  const { values } = parseArgs({ options: { directory: { type: "string" }, knowledge: { type: "string" }, provider: { type: "string" }, "stop-after": { type: "string" } } });
  if (values["stop-after"] && !["queries", "evidence"].includes(values["stop-after"])) throw new Error("Invalid stop stage");
  if (values.knowledge && !["internal", "external", "both"].includes(values.knowledge)) throw new Error("Invalid knowledge source");
  if (values.directory && values.knowledge) throw new Error("Resume uses the archived request knowledge selection");
  const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider]) throw new Error("Configure a model provider"); const model = config.providers[provider].model ?? config.model?.model; if (!model) throw new Error("Configure a model");
  await mkdir(".examples-retrieval-tasks", { recursive: true }); const directory = values.directory ? resolve(values.directory) : await mkdtemp(resolve(".examples-retrieval-tasks/cli-"));
  if (!values.directory) await createFixture(directory, mode, { knowledge: (values.knowledge ?? "external") as Request["knowledge"] });
  const r = request(JSON.parse(await readFile(join(directory, "request.json"), "utf8"))); if (r.mode !== mode) throw new Error("Request belongs to another example");
  const adapters = new RetrievalAdapters(directory, r);
  try {
    const storage = await openAgentStorage(directory, config);
    try {
      const runtime = createDitto({ config, sandbox: sandbox(config, r, adapters), workers: [...storage.workers, createInferWorker(), createRetrievalWorker({ providers: adapters.providers, defaults: config.retrieval }), createInteractionWorker({ tools: adapters.tools })] });
      const controller = new AbortController(), cancel = () => controller.abort(); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
      try {
        if (!values.directory && r.knowledge !== "external" && ["knowledge-base", "multi-source"].includes(r.mode)) await importInternalKnowledge(runtime, r.tenant, JSON.parse(await readFile(join(directory, "internal-knowledge.json"), "utf8")));
        const result = await runRetrieval(runtime, { request: r, model: { provider, model } }, { signal: controller.signal, ...(values["stop-after"] ? { stopAfter: values["stop-after"] as "queries" | "evidence" } : {}) }); console.log(JSON.stringify({ directory, result }, null, 2)); }
      finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); await runtime.close(); }
    } finally { await storage.close(); }
  } finally { adapters.close(); }
}
