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
  CandidateAdapters,
  createDemo,
} from "../../_shared/tools/candidates/adapters.ts";
import {
  request,
  type Request,
} from "../../_shared/tools/candidates/domain.ts";
import { runCandidates, type Options } from "./index.ts";
export async function openCandidates(
  directory: string,
  r: Request,
  config: RuntimeConfig,
) {
  const adapters = new CandidateAdapters(directory, r);
  const storage = await openAgentStorage(directory, config);
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
      count: { type: "string" },
      mode: { type: "string" },
      score: { type: "string" },
      "no-fallback": { type: "boolean" },
      calls: { type: "string" },
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
    !["candidate", "assessment", "fusion", "report"].includes(
      values["stop-after"],
    )
  )
    throw new Error("Invalid checkpoint");
  if (values.scenario && !["normal", "missing-facts"].includes(values.scenario))
    throw new Error("Invalid scenario");
  const config = loadRuntimeConfigFile("ditto.yaml", process.env),
    provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider])
    throw new Error("Configure model provider");
  const model = config.providers[provider].model ?? config.model?.model;
  if (!model) throw new Error("Configure model");
  await mkdir(".examples-candidates-tasks", { recursive: true });
  const directory = values.directory
    ? resolve(values.directory)
    : await mkdtemp(resolve(".examples-candidates-tasks/cli-"));
  const r = values.directory
    ? request(
        JSON.parse(await readFile(join(directory, "request.json"), "utf8")),
      )
    : await createDemo(
        directory,
        {
          ...(values.goal ? { goal: values.goal } : {}),
          ...(values.count ? { count: Number(values.count) } : {}),
          ...(values.calls ? { maxModelCalls: Number(values.calls) } : {}),
          ...(values.score ? { minScore: Number(values.score) } : {}),
          mode: (values.mode ?? "select") as Request["mode"],
          allowFallback: !values["no-fallback"],
        },
        values.scenario === "missing-facts",
      );
  const app = await openCandidates(directory, r, config),
    controller = new AbortController(),
    cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await runCandidates(
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
