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
import { openAgentStorage } from "../../_shared/tools/storage/workers.ts";
import {
  DebateAdapters,
  createDemo,
  type Scenario,
} from "../../_shared/tools/debate/adapters.ts";
import { request, type Request } from "../../_shared/tools/debate/domain.ts";
import { runDebate, type Options } from "./index.ts";
export async function openDebate(
  directory: string,
  r: Request,
  config: RuntimeConfig,
) {
  const adapters = new DebateAdapters(directory, r),
    storage = await openAgentStorage(directory, config);
  try {
    const runtime = createDitto({
      config,
      sandbox: {
        ...config.sandbox,
        tools: adapters.tools.map((t) => t.name),
      },
      workers: [
        ...storage.workers,
        createInferWorker({ concurrency: 4 }),
        createInteractionWorker({ tools: adapters.tools, concurrency: 4 }),
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
          await storage.close();
        }
      },
    };
  } catch (e) {
    await storage.close();
    throw e;
  }
}
export async function runCli() {
  const { values } = parseArgs({
    options: {
      directory: { type: "string" },
      provider: { type: "string" },
      scenario: { type: "string" },
      question: { type: "string" },
      "stop-after": { type: "string" },
    },
  });
  if (values.directory && (values.scenario || values.question))
    throw new Error("Resume retains the original request");
  if (
    values["stop-after"] &&
    !["views", "comparison", "report"].includes(values["stop-after"])
  )
    throw new Error("Invalid checkpoint");
  const config = loadRuntimeConfigFile("ditto.yaml", process.env),
    provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider])
    throw new Error("Configure provider");
  const model = config.providers[provider].model ?? config.model?.model;
  if (!model) throw new Error("Configure model");
  await mkdir(".examples-debate-tasks", { recursive: true });
  const directory = values.directory
      ? resolve(values.directory)
      : await mkdtemp(resolve(".examples-debate-tasks/cli-")),
    r = values.directory
      ? request(
          JSON.parse(await readFile(join(directory, "request.json"), "utf8")),
        )
      : await createDemo(
          directory,
          {
            ...(values.question ? { question: values.question } : {}),
          },
          (values.scenario ?? "tradeoffs") as Scenario,
        ),
    app = await openDebate(directory, r, config),
    controller = new AbortController(),
    cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await runDebate(
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
