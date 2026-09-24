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
import { contentTools } from "../../_shared/tools/content/tools.ts";
import {
  createFixture,
  resumeFixture,
} from "../../_shared/tools/content/fixtures.ts";
import type { Mode } from "../../_shared/tools/content/domain.ts";
import { runContent } from "./shared.ts";
export const isMain = (url: string) =>
  !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
export const sandbox = (config: RuntimeConfig) => ({
  ...config.sandbox,
  tools: ["content_sources", "content_publish"],
});
export async function runCli(mode: Mode) {
  const { values } = parseArgs({
      options: {
        directory: { type: "string" },
        provider: { type: "string" },
        checkpoint: { type: "boolean" },
      },
    }),
    config = loadRuntimeConfigFile("ditto.yaml", process.env),
    provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider])
    throw new Error("Configure a provider");
  const model = config.providers[provider].model ?? config.model?.model;
  if (!model) throw new Error("Configure a model");
  await mkdir(".examples-content-tasks", { recursive: true });
  const directory = values.directory
      ? resolve(values.directory)
      : await mkdtemp(resolve(".examples-content-tasks/cli-")),
    r = values.directory
      ? await resumeFixture(directory)
      : await createFixture(directory, mode);
  if (r.mode !== mode) throw new Error("Mode mismatch");
  const storage = await openAgentStorage(directory, config);
  try {
    const runtime = createDitto({
        config,
        sandbox: sandbox(config),
        workers: [
          ...storage.workers,
          createInferWorker(),
          createInteractionWorker({ tools: contentTools(directory, r) }),
        ],
      }),
      controller = new AbortController(),
      cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const result = await runContent(
        runtime,
        { request: r, model: { provider, model } },
        {
          signal: controller.signal,
          ...(values.checkpoint ? { stopAfter: "draft" as const } : {}),
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
