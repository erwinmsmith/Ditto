import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  createDitto,
  loadRuntimeConfigFile,
  type RuntimeConfig,
} from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "../../_shared/tools/storage/workers.ts";
import {
  SupervisorAdapters,
  createDemo,
  type Scenario,
} from "../../_shared/tools/supervisor/adapters.ts";
import {
  request,
  type Request,
} from "../../_shared/tools/supervisor/domain.ts";
import { runSupervisor, type Options } from "./index.ts";
export async function openSupervisor(
  directory: string,
  r: Request,
  config: RuntimeConfig,
) {
  const adapters = new SupervisorAdapters(directory, r),
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
      goal: { type: "string" },
      "stop-after": { type: "string" },
    },
  });
  if (values.directory && (values.scenario || values.goal))
    throw new Error("Resume retains the original request");
  if (
    values["stop-after"] &&
    !["decision", "delegation", "report"].includes(values["stop-after"])
  )
    throw new Error("Invalid checkpoint");
  const config = loadRuntimeConfigFile("ditto.yaml", process.env),
    provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider])
    throw new Error("Configure provider");
  const model = config.providers[provider].model ?? config.model?.model;
  if (!model) throw new Error("Configure model");
  await mkdir(".examples-supervisor-tasks", { recursive: true });
  const directory = values.directory
      ? resolve(values.directory)
      : await mkdtemp(resolve(".examples-supervisor-tasks/cli-")),
    r = values.directory
      ? request(
          JSON.parse(await readFile(join(directory, "request.json"), "utf8")),
        )
      : await createDemo(
          directory,
          {
            ...(values.goal ? { goal: values.goal } : {}),
          },
          (values.scenario ?? "recheck") as Scenario,
        ),
    app = await openSupervisor(directory, r, config),
    controller = new AbortController(),
    cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await runSupervisor(
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
