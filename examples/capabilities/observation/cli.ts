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
import { ResultTools } from "../../_shared/tools/observation/tools.ts";
import {
  type Mode,
  type Request,
} from "../../_shared/tools/observation/domain.ts";
import {
  createFixture,
  resumeFixture,
} from "../../_shared/tools/observation/service.ts";
import { runObservation } from "./shared.ts";
export const isMain = (url: string) =>
  !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
export const sandbox = (config: RuntimeConfig, r: Request) => ({
  ...config.sandbox,
  tools: [
    "result_read",
    "result_retry",
    "result_status",
    "result_commit",
    "result_publish",
  ],
  network: [...(config.sandbox?.network ?? []), r.origin],
});
export async function runCli(mode: Mode) {
  const { values } = parseArgs({
    options: {
      directory: { type: "string" },
      provider: { type: "string" },
      checkpoint: { type: "boolean" },
    },
  });
  const config = loadRuntimeConfigFile("ditto.yaml", process.env),
    provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider])
    throw new Error("Configure a model provider");
  const model = config.providers[provider].model ?? config.model?.model;
  if (!model) throw new Error("Configure a model");
  await mkdir(".examples-observation-tasks", { recursive: true });
  const directory = values.directory
    ? resolve(values.directory)
    : await mkdtemp(resolve(".examples-observation-tasks/cli-"));
  const fixture = values.directory
    ? await resumeFixture(directory)
    : await createFixture(directory, mode);
  try {
    if (fixture.request.mode !== mode) throw new Error("Mode mismatch");
    const storage = await openAgentStorage(directory, config);
    try {
      const adapters = new ResultTools(directory, fixture.request);
      try {
        const runtime = createDitto({
          config,
          sandbox: sandbox(config, fixture.request),
          workers: [
            ...storage.workers,
            createInferWorker(),
            createInteractionWorker({ tools: adapters.tools }),
          ],
        });
        const controller = new AbortController(),
          cancel = () => controller.abort();
        process.once("SIGINT", cancel);
        process.once("SIGTERM", cancel);
        try {
          const result = await runObservation(
            runtime,
            { request: fixture.request, model: { provider, model } },
            {
              signal: controller.signal,
              ...(values.checkpoint ? { stopAfter: "decision" as const } : {}),
            },
          );
          console.log(JSON.stringify({ directory, result }, null, 2));
        } finally {
          process.off("SIGINT", cancel);
          process.off("SIGTERM", cancel);
          await runtime.close();
        }
      } finally {
        adapters.close();
      }
    } finally {
      await storage.close();
    }
  } finally {
    await fixture.service.close();
  }
}
