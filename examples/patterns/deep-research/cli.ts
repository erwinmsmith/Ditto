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
  ResearchAdapters,
  createTask,
} from "../../_shared/tools/research/adapters.ts";
import { request, type Request } from "../../_shared/tools/research/domain.ts";
import {
  searchConfig,
  type SearchConfig,
} from "../../_shared/tools/web-search/providers.ts";
import {
  transportConfig,
  type TransportOptions,
} from "../../_shared/tools/web-search/http.ts";
import { runResearch, type Options } from "./index.ts";
import { defaultRequest } from "./fixtures.ts";
export async function openResearch(
  directory: string,
  r: Request,
  config: RuntimeConfig,
  search: SearchConfig = searchConfig(),
  transport: TransportOptions = transportConfig(),
) {
  const adapters = new ResearchAdapters(directory, r, search, transport),
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
      scope: { type: "string" },
      audience: { type: "string" },
      "research-type": { type: "string" },
      rounds: { type: "string" },
      searches: { type: "string" },
      pages: { type: "string" },
      "model-calls": { type: "string" },
      "research-seconds": { type: "string" },
      origins: { type: "string" },
      references: { type: "string" },
      provider: { type: "string" },
      "cross-check": { type: "boolean" },
      "stop-after": { type: "string" },
    },
  });
  if (
    values.directory &&
    Object.keys(values).some(
      (key) => !["directory", "provider", "stop-after"].includes(key),
    )
  )
    throw new Error(
      "Resume uses the saved trusted request; create a new task for changed requirements",
    );
  if (
    values["stop-after"] &&
    !["plan", "round", "report"].includes(values["stop-after"])
  )
    throw new Error("Invalid stop stage");
  const config = loadRuntimeConfigFile("ditto.yaml", process.env),
    provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider])
    throw new Error("Configure model provider");
  const model = config.providers[provider].model ?? config.model?.model;
  if (!model) throw new Error("Configure model");
  const search = searchConfig();
  await mkdir(".examples-research-tasks", { recursive: true });
  const directory = values.directory
    ? resolve(values.directory)
    : await mkdtemp(resolve(".examples-research-tasks/cli-"));
  const r = values.directory
    ? request(
        JSON.parse(
          await readFile(join(directory, "research-request.json"), "utf8"),
        ),
      )
    : await createTask(
        directory,
        defaultRequest({
          ...(values.question
            ? {
                question: values.question,
                scope:
                  "Answer the requested research question from documented evidence; disclose uncertainty and missing sources.",
                referenceUrls: [],
              }
            : {}),
          ...(values.scope ? { scope: values.scope } : {}),
          ...(values.audience ? { audience: values.audience } : {}),
          ...(values["research-type"]
            ? {
                researchType: values[
                  "research-type"
                ] as Request["researchType"],
              }
            : {}),
          ...(values.rounds ? { maxRounds: Number(values.rounds) } : {}),
          ...(values.searches ? { maxSearches: Number(values.searches) } : {}),
          ...(values.pages ? { maxReadPages: Number(values.pages) } : {}),
          ...(values["model-calls"]
            ? { maxModelCalls: Number(values["model-calls"]) }
            : {}),
          ...(values["research-seconds"]
            ? { researchSeconds: Number(values["research-seconds"]) }
            : {}),
          ...(values.origins
            ? { allowedOrigins: values.origins.split(","), referenceUrls: [] }
            : {}),
          ...(values.references
            ? { referenceUrls: values.references.split(",") }
            : {}),
          crossCheck: values["cross-check"] ?? false,
        }),
        search,
      );
  const app = await openResearch(directory, r, config, search),
    controller = new AbortController(),
    cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await runResearch(
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
