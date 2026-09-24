import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
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
import { dataCodeTools } from "../../_shared/tools/data-and-code/tools.ts";
import {
  createFixture,
  resumeFixture,
} from "../../_shared/tools/data-and-code/fixtures.ts";
import {
  tools,
  type Request,
  type Mode,
} from "../../_shared/tools/data-and-code/domain.ts";
import { runDataCode } from "./shared.ts";
export const isMain = (url: string) =>
  !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
export const sandbox = (c: RuntimeConfig, r: Request) => ({
  ...c.sandbox,
  tools: ["data_code_sources", tools[r.mode], "data_code_publish"],
});
export const toolConfig = () => ({
  python:
    process.env.DITTO_EXAMPLE_DATA_PYTHON ??
    resolve("examples/_shared/tools/.venv/bin/python"),
});
export function model(c: RuntimeConfig) {
  if (!c.model?.provider || !c.model.model)
    throw new Error("Configure a text model");
  return { provider: c.model.provider, model: c.model.model };
}
export async function runCli(mode: Mode) {
  const { values } = parseArgs({
      options: {
        directory: { type: "string" },
        checkpoint: { type: "boolean" },
      },
    }),
    config = loadRuntimeConfigFile("ditto.yaml", process.env);
  await mkdir(".examples-data-code-tasks", { recursive: true });
  const directory = values.directory
      ? resolve(values.directory)
      : await mkdtemp(resolve(".examples-data-code-tasks/cli-")),
    r = values.directory
      ? await resumeFixture(directory)
      : await createFixture(directory, mode);
  if (r.mode !== mode) throw new Error("Mode mismatch");
  const storage = await openAgentStorage(directory, config);
  try {
    const runtime = createDitto({
        config,
        sandbox: sandbox(config, r),
        workers: [
          ...storage.workers,
          createInferWorker(),
          createInteractionWorker({
            tools: dataCodeTools(directory, r, toolConfig()),
          }),
        ],
      }),
      controller = new AbortController(),
      cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const result = await runDataCode(
        runtime,
        { request: r, model: model(config) },
        {
          signal: controller.signal,
          ...(values.checkpoint ? { stopAfter: "outcome" as const } : {}),
        },
      );
      console.log(JSON.stringify({ directory, result }, null, 2));
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
      await runtime.close();
    }
  } finally {
    await storage.close();
  }
}
