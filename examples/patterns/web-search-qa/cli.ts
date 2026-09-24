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
  WebAdapters,
  createTask,
} from "../../_shared/tools/web-search/adapters.ts";
import {
  request,
  type Request,
} from "../../_shared/tools/web-search/domain.ts";
import {
  searchConfig,
  type SearchConfig,
} from "../../_shared/tools/web-search/providers.ts";
import {
  transportConfig,
  type TransportOptions,
} from "../../_shared/tools/web-search/http.ts";
import { runWebQa, type Options } from "./index.ts";
import { defaultRequest } from "./fixtures.ts";
export async function openWebQa(
  directory: string,
  r: Request,
  config: RuntimeConfig,
  search: SearchConfig = searchConfig(),
  transport: TransportOptions = transportConfig(),
) {
  const adapters = new WebAdapters(directory, r, search, transport),
    storage = await openAgentStorage(directory, config);
  try {
    const runtime = createDitto({
      config,
      sandbox: {
        ...config.sandbox,
        tools: adapters.tools.map((t) => t.name),
        network: [
          ...(config.sandbox?.network ?? []),
          adapters.provider.origin,
          ...r.allowedOrigins,
        ],
      },
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
      question: { type: "string" },
      origins: { type: "string" },
      references: { type: "string" },
      provider: { type: "string" },
      "cross-check": { type: "boolean" },
      "stop-after": { type: "string" },
    },
  });
  if (
    values.directory &&
    (values.question ||
      values.origins ||
      values.references ||
      values["cross-check"])
  )
    throw new Error(
      "Resume uses the saved trusted request; create a new task for changed requirements",
    );
  if (
    values["stop-after"] &&
    !["plan", "searched", "read", "selected", "report"].includes(
      values["stop-after"],
    )
  )
    throw new Error("Invalid stop stage");
  const config = loadRuntimeConfigFile("ditto.yaml", process.env),
    provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider])
    throw new Error("Configure model provider");
  const model = config.providers[provider].model ?? config.model?.model;
  if (!model) throw new Error("Configure model");
  const search = searchConfig();
  await mkdir(".examples-web-search-tasks", { recursive: true });
  const directory = values.directory
    ? resolve(values.directory)
    : await mkdtemp(resolve(".examples-web-search-tasks/cli-"));
  const r = values.directory
    ? request(
        JSON.parse(await readFile(join(directory, "request.json"), "utf8")),
      )
    : await createTask(
        directory,
        defaultRequest({
          ...(values.question ? { question: values.question } : {}),
          ...(values.origins
            ? { allowedOrigins: values.origins.split(",") }
            : {}),
          ...(values.references
            ? { referenceUrls: values.references.split(",") }
            : {}),
          crossCheck: values["cross-check"] ?? false,
        }),
        search,
      );
  const app = await openWebQa(directory, r, config, search),
    controller = new AbortController(),
    cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await runWebQa(
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
