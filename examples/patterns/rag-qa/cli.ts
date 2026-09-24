import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  createDitto,
  loadRuntimeConfigFile,
  type RuntimeConfig,
} from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { createRetrievalWorker } from "@ditto/core/worker/retrieval";
import { openAgentStorage } from "../../_shared/tools/storage/workers.ts";
import { RagAdapters } from "../../_shared/tools/rag/adapters.ts";
import { request, type Request } from "../../_shared/tools/rag/domain.ts";
import { runRag, type Options } from "./index.ts";
import { createFixture, seedInternalKnowledge } from "./fixtures.ts";
export async function openRag(
  directory: string,
  r: Request,
  config: RuntimeConfig,
) {
  const adapters = new RagAdapters(directory, r);
  try {
    const storage = await openAgentStorage(directory, config);
    try {
      const runtime = createDitto({
        config,
        sandbox: {
          ...config.sandbox,
          tools: adapters.tools.map((t) => t.name),
        },
        workers: [
          ...storage.workers,
          createInferWorker(),
          createRetrievalWorker({ providers: adapters.providers }),
          createInteractionWorker({ tools: adapters.tools }),
        ],
      });
      return {
        runtime,
        storage,
        adapters,
        async close() {
          try {
            await runtime.close();
          } finally {
            try {
              await storage.close();
            } finally {
              adapters.close();
            }
          }
        },
      };
    } catch (error) {
      await storage.close();
      throw error;
    }
  } catch (error) {
    adapters.close();
    throw error;
  }
}
export async function runCli() {
  const { values } = parseArgs({
    options: {
      directory: { type: "string" },
      question: { type: "string" },
      sources: { type: "string" },
      provider: { type: "string" },
      "stop-after": { type: "string" },
    },
  });
  if (values.directory && (values.question || values.sources))
    throw new Error(
      "Resume uses request.json; create a new task for a new question",
    );
  if (
    values["stop-after"] &&
    !["indexed", "retrieved", "selected", "report"].includes(
      values["stop-after"],
    )
  )
    throw new Error("Invalid stop stage");
  const config = loadRuntimeConfigFile("ditto.yaml", process.env),
    provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider])
    throw new Error("Configure model provider");
  const model = config.providers[provider].model ?? config.model?.model;
  if (!model) throw new Error("Configure model");
  await mkdir(".examples-rag-tasks", { recursive: true });
  const directory = values.directory
    ? resolve(values.directory)
    : await mkdtemp(resolve(".examples-rag-tasks/cli-"));
  if (!values.directory)
    await createFixture(directory, {
      ...(values.question ? { question: values.question } : {}),
      ...(values.sources ? { sourceIds: values.sources.split(",") } : {}),
    });
  const r = request(
      JSON.parse(await readFile(join(directory, "request.json"), "utf8")),
    ),
    app = await openRag(directory, r, config),
    controller = new AbortController(),
    cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (!values.directory) await seedInternalKnowledge(app.runtime);
    const result = await runRag(
      app.runtime,
      { request: r, model: { provider, model } },
      {
        signal: controller.signal,
        ...(values["stop-after"]
          ? {
              stopAfter: values["stop-after"] as NonNullable<
                Options["stopAfter"]
              >,
            }
          : {}),
      },
    );
    console.log(JSON.stringify({ directory, result }, null, 2));
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    await app.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runCli();
