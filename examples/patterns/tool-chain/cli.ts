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
  ChainAdapters,
  createTask,
} from "../../_shared/tools/tool-chain/adapters.ts";
import {
  request,
  type Request,
} from "../../_shared/tools/tool-chain/domain.ts";
import {
  createDemo,
  resumeDemo,
  type Scenario,
} from "../../_shared/tools/tool-chain/service.ts";
import { runToolChain, type Options } from "./index.ts";
export async function openToolChain(
  directory: string,
  r: Request,
  config: RuntimeConfig,
) {
  const adapters = new ChainAdapters(directory, r),
    storage = await openAgentStorage(directory, config);
  try {
    const runtime = createDitto({
      config,
      sandbox: {
        ...config.sandbox,
        tools: adapters.tools.map((t) => t.name),
        network: [...(config.sandbox?.network ?? []), r.origin],
      },
      workers: [
        ...storage.workers,
        createInferWorker(),
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
      mode: { type: "string" },
      goal: { type: "string" },
      "no-notify": { type: "boolean" },
      "no-write": { type: "boolean" },
      "stop-after": { type: "string" },
    },
  });
  if (
    values.directory &&
    Object.keys(values).some(
      (k) => !["directory", "provider", "stop-after"].includes(k),
    )
  )
    throw new Error(
      "Resume uses the saved task; create a new directory for changed requirements",
    );
  const scenario = (values.scenario ?? "exception") as Scenario;
  if (
    values["stop-after"] &&
    !["reads", "analysis", "crm", "notification", "report"].includes(
      values["stop-after"],
    )
  )
    throw new Error("Invalid checkpoint");
  const config = loadRuntimeConfigFile("ditto.yaml", process.env),
    provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider])
    throw new Error("Configure model provider");
  const model = config.providers[provider].model ?? config.model?.model;
  if (!model) throw new Error("Configure model");
  await mkdir(".examples-tool-chain-tasks", { recursive: true });
  const directory = values.directory
    ? resolve(values.directory)
    : await mkdtemp(resolve(".examples-tool-chain-tasks/cli-"));
  const demo = values.directory
    ? await resumeDemo(directory)
    : await createDemo(directory, scenario, {
        mode: (values.mode ?? "conditional") as Request["mode"],
        allowCrmWrite: !values["no-write"],
        allowNotify: !values["no-notify"],
        ...(values.goal ? { goal: values.goal } : {}),
      });
  let app: Awaited<ReturnType<typeof openToolChain>> | undefined;
  const controller = new AbortController(),
    cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const r = values.directory
      ? request(
          JSON.parse(await readFile(join(directory, "request.json"), "utf8")),
        )
      : await createTask(directory, demo.request);
    app = await openToolChain(directory, r, config);
    const result = await runToolChain(
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
    try {
      await app?.close();
    } finally {
      await demo.service.close();
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runCli();
