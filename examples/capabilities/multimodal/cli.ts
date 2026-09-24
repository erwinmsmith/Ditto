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
import {
  mediaTools,
  toolNames,
  type MediaConfig,
} from "../../_shared/tools/multimodal/tools.ts";
import {
  createFixture,
  resumeFixture,
} from "../../_shared/tools/multimodal/fixtures.ts";
import type { Mode } from "../../_shared/tools/multimodal/domain.ts";
import { runMultimodal } from "./shared.ts";
export const isMain = (url: string) =>
  !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
export const sandbox = (c: RuntimeConfig) => ({
  ...c.sandbox,
  tools: toolNames,
});
export function mediaConfig(): MediaConfig {
  return {
    python:
      process.env.DITTO_EXAMPLE_MEDIA_PYTHON ??
      resolve("examples/_shared/tools/.venv/bin/python"),
    asrModel: process.env.DITTO_EXAMPLE_ASR_MODEL ?? "tiny.en",
    asrLanguage: process.env.DITTO_EXAMPLE_ASR_LANGUAGE ?? "en",
  };
}
export function models(c: RuntimeConfig) {
  const provider = c.model?.provider,
    model = c.model?.model;
  if (!provider || !model) throw new Error("Configure the text model");
  const vp = process.env.DITTO_EXAMPLE_VISION_PROVIDER,
    vm = process.env.DITTO_EXAMPLE_VISION_MODEL;
  if ((vp && !vm) || (vm && !vp))
    throw new Error("Configure both vision provider and model");
  return {
    model: { provider, model },
    ...(vp && vm
      ? {
          visionModel: {
            provider: vp,
            model: vm,
            providerOptions: { response_format: { type: "json_object" } },
          },
        }
      : {}),
  };
}
export async function runCli(mode: Mode) {
  const { values } = parseArgs({
      options: {
        directory: { type: "string" },
        checkpoint: { type: "boolean" },
      },
    }),
    config = loadRuntimeConfigFile("ditto.yaml", process.env),
    mc = mediaConfig();
  await mkdir(".examples-multimodal-tasks", { recursive: true });
  const directory = values.directory
      ? resolve(values.directory)
      : await mkdtemp(resolve(".examples-multimodal-tasks/cli-")),
    r = values.directory
      ? await resumeFixture(directory)
      : await createFixture(directory, mode, mc.python);
  if (r.mode !== mode) throw new Error("Mode mismatch");
  const storage = await openAgentStorage(directory, config);
  try {
    const runtime = createDitto({
        config,
        sandbox: sandbox(config),
        workers: [
          ...storage.workers,
          createInferWorker(),
          createInteractionWorker({ tools: mediaTools(directory, r, mc) }),
        ],
      }),
      controller = new AbortController(),
      cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const result = await runMultimodal(
        runtime,
        { request: r, ...models(config) },
        {
          signal: controller.signal,
          ...(values.checkpoint ? { stopAfter: "material" as const } : {}),
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
