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
  PlanAdapters,
  createDemo,
  type Scenario,
} from "../../_shared/tools/plan-execute/adapters.ts";
import {
  request,
  type Request,
} from "../../_shared/tools/plan-execute/domain.ts";
import { runPlanExecute, type Options } from "./index.ts";
export async function openPlanExecute(
  directory: string,
  r: Request,
  config: RuntimeConfig,
) {
  const adapters = new PlanAdapters(directory, r);
  let storage: Awaited<ReturnType<typeof openAgentStorage>>;
  try {
    storage = await openAgentStorage(directory, config);
  } catch (e) {
    adapters.close();
    throw e;
  }
  try {
    const runtime = createDitto({
      config,
      sandbox: { ...config.sandbox, tools: adapters.tools.map((t) => t.name) },
      workers: [
        ...storage.workers,
        createInferWorker(),
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
  } catch (e) {
    try {
      await storage.close();
    } finally {
      adapters.close();
    }
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
      plans: { type: "string" },
      actions: { type: "string" },
      "stop-after": { type: "string" },
    },
  });
  if (
    values.directory &&
    Object.keys(values).some(
      (k) => !["directory", "provider", "stop-after"].includes(k),
    )
  )
    throw new Error("Resume uses the saved request");
  if (
    values["stop-after"] &&
    !["plan", "step", "report"].includes(values["stop-after"])
  )
    throw new Error("Invalid checkpoint");
  const config = loadRuntimeConfigFile("ditto.yaml", process.env),
    provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider])
    throw new Error("Configure model provider");
  const model = config.providers[provider].model ?? config.model?.model;
  if (!model) throw new Error("Configure model");
  await mkdir(".examples-plan-execute-tasks", { recursive: true });
  const directory = values.directory
    ? resolve(values.directory)
    : await mkdtemp(resolve(".examples-plan-execute-tasks/cli-"));
  const r = values.directory
    ? request(
        JSON.parse(await readFile(join(directory, "request.json"), "utf8")),
      )
    : await createDemo(
        directory,
        (values.scenario ?? "price-change") as Scenario,
        {
          ...(values.goal ? { goal: values.goal } : {}),
          ...(values.plans ? { maxPlans: Number(values.plans) } : {}),
          ...(values.actions ? { maxActions: Number(values.actions) } : {}),
        },
      );
  const app = await openPlanExecute(directory, r, config),
    controller = new AbortController(),
    cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await runPlanExecute(
      app.runtime,
      { request: r, model: { provider, model } },
      {
        signal: controller.signal,
        ...(values["stop-after"]
          ? { stopAfter: values["stop-after"] as Options["stopAfter"] & string }
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
