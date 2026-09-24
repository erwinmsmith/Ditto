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
  ReviewApplication,
  createDemo,
  request,
  type Request,
} from "../../_shared/tools/human-loop/adapters.ts";
import { draft } from "../../_shared/tools/human-review-store.ts";
import { runHumanLoop, type Options } from "./index.ts";
export async function openHumanLoop(
  directory: string,
  r: Request,
  config: RuntimeConfig,
) {
  const adapters = await ReviewApplication.open(directory, r);
  let storage;
  try {
    storage = await openAgentStorage(directory, config);
  } catch (error) {
    adapters.close();
    throw error;
  }
  try {
    const runtime = createDitto({
      config,
      sandbox: {
        ...config.sandbox,
        tools: adapters.tools.map((t) => t.name),
      },
      workers: [
        ...storage.workers,
        createInferWorker(),
        createInteractionWorker({
          tools: adapters.tools,
          output: adapters.output,
        }),
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
      goal: { type: "string" },
      conflict: { type: "boolean" },
      "stop-after": { type: "string" },
      decision: { type: "string" },
      actor: { type: "string" },
      "review-id": { type: "string" },
      token: { type: "string" },
      "edit-file": { type: "string" },
      note: { type: "string" },
    },
  });
  const acting = !!values.decision || !!values["edit-file"];
  if (
    acting &&
    (!values.directory ||
      !values.actor ||
      !values["review-id"] ||
      !values.token)
  )
    throw new Error(
      "A human command requires directory, actor, review-id and token",
    );
  if (values.decision && values["edit-file"])
    throw new Error("Edit and approve are separate actions");
  if (
    values.decision &&
    !["approve", "reject", "claim"].includes(values.decision)
  )
    throw new Error("Invalid human decision");
  if (values.directory && (values.goal || values.conflict))
    throw new Error("Resume retains the original request");
  if (
    values["stop-after"] &&
    !["draft", "continued", "effect"].includes(values["stop-after"])
  )
    throw new Error("Invalid checkpoint");
  const config = loadRuntimeConfigFile("ditto.yaml", process.env),
    provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider])
    throw new Error("Configure provider");
  const model = config.providers[provider].model ?? config.model?.model;
  if (!model) throw new Error("Configure model");
  await mkdir(".examples-human-loop-tasks", { recursive: true });
  const directory = values.directory
    ? resolve(values.directory)
    : await mkdtemp(resolve(".examples-human-loop-tasks/cli-"));
  const r = values.directory
    ? request(
        JSON.parse(await readFile(join(directory, "request.json"), "utf8")),
      )
    : await createDemo(
        directory,
        values.goal ? { goal: values.goal } : {},
        values.conflict,
      );
  const app = await openHumanLoop(directory, r, config),
    controller = new AbortController(),
    cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (acting) {
      const common = {
        requestId: values["review-id"]!,
        expectedToken: values.token!,
        actor: values.actor!,
      };
      if (values["edit-file"])
        await app.adapters.edit({
          ...common,
          replacement: draft(
            JSON.parse(await readFile(resolve(values["edit-file"]), "utf8")),
          ),
          note: values.note ?? "Human edited draft",
        });
      else if (values.decision === "claim")
        await app.adapters.claim({
          ...common,
          note: values.note ?? "Human accepted handoff",
        });
      else
        await app.adapters.decide({
          ...common,
          choice: values.decision as "approve" | "reject",
          ...(values.note ? { note: values.note } : {}),
        });
    }
    const result = await runHumanLoop(
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
