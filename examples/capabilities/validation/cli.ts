import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
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
  openValidationTools,
  toolNames,
} from "../../_shared/tools/validation/tools.ts";
import {
  createFixture,
  resumeFixture,
} from "../../_shared/tools/validation/fixtures.ts";
import {
  type Request,
  type Mode,
} from "../../_shared/tools/validation/domain.ts";
import { runValidation } from "./shared.ts";
export const isMain = (url: string) =>
  !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
export const sandbox = (c: RuntimeConfig, _r: Request) => ({
  ...c.sandbox,
  tools: toolNames,
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
  await mkdir(".examples-validation-tasks", { recursive: true });
  const directory = values.directory
      ? resolve(values.directory)
      : await mkdtemp(resolve(".examples-validation-tasks/cli-")),
    r = values.directory
      ? await resumeFixture(directory)
      : await createFixture(directory, mode);
  if (r.mode !== mode) throw new Error("Mode mismatch");
  const storage = await openAgentStorage(directory, config);
  let business: ReturnType<typeof openValidationTools> | undefined;
  try {
    business = openValidationTools(directory, r);
    const runtime = createDitto({
        config,
        sandbox: sandbox(config, r),
        workers: [
          ...storage.workers,
          createInferWorker(),
          createInteractionWorker({
            tools: business.tools,
          }),
        ],
      }),
      controller = new AbortController(),
      cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const result = await runValidation(
        runtime,
        { request: r, model: model(config) },
        {
          signal: controller.signal,
          ...(values.checkpoint ? { stopAfter: "assessment" as const } : {}),
        },
      );
      console.log(JSON.stringify({ directory, result }, null, 2));
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
      await runtime.close();
    }
  } finally {
    business?.close();
    await storage.close();
  }
}
