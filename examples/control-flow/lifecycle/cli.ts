import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createContextWorker } from "@ditto/core/worker/context";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { LifecycleStore, type Result } from "../../_shared/tools/lifecycle-store.ts";
import { createFixture, emitEvent, type Mode } from "./fixtures.ts";
import type { Runner, Input, Options } from "./shared.ts";
export const isMain = (url: string) => !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
export async function runCli(run: (runtime: Runner, input: Input, options?: Options & { waitMs?: number }) => Promise<Result>, mode: Mode) {
  const { values } = parseArgs({ options: { directory: { type: "string" }, provider: { type: "string" }, "due-at": { type: "string" }, "wait-ms": { type: "string" }, "deadline-ms": { type: "string" }, "model-call-budget": { type: "string" }, "emit-event": { type: "boolean" }, ready: { type: "boolean" }, stop: { type: "boolean" } } });
  const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider]) throw new Error("Configure a model provider");
  const model = config.providers[provider].model ?? config.model?.model; if (!model) throw new Error("Configure a model");
  if ((values.ready || values.stop || values["emit-event"]) && !values.directory) throw new Error("Controller actions require an existing --directory");
  if (values.directory && (values["due-at"] || values["deadline-ms"] || values["model-call-budget"])) throw new Error("Task limits and trigger are fixed at creation");
  if (values["due-at"] && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(values["due-at"])) throw new Error("--due-at requires an ISO timestamp with timezone");
  await mkdir(".examples-lifecycle-tasks", { recursive: true });
  const directory = values.directory ? resolve(values.directory) : await mkdtemp(resolve(".examples-lifecycle-tasks/cli-"));
  if (!values.directory) await createFixture(directory, mode);
  else if (JSON.parse(await readFile(resolve(directory, "application.json"), "utf8")).mode !== mode) throw new Error("Directory belongs to another workflow");
  const store = new LifecycleStore(directory), controller = new AbortController();
  const cancel = () => controller.abort(new Error("CLI interrupted")); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const runtime = createDitto({ config, sandbox: { ...config.sandbox, tools: store.tools.map(tool => tool.name) }, workers: [createContextWorker(), createInferWorker(), createInteractionWorker({ tools: store.tools })] });
  try {
    if (!values.directory) {
      const dueAt = values["due-at"] ? Date.parse(values["due-at"]) : Date.now() + 250;
      await store.create("task", mode === "scheduled" ? { kind: "time", dueAt } : mode === "event" ? { kind: "event" } : { kind: "manual" }, {
        modelCallBudget: Number(values["model-call-budget"] ?? (mode === "stop" ? 0 : 1)),
        ...(values["deadline-ms"] === undefined ? {} : { deadlineAt: Date.now() + Number(values["deadline-ms"]) }),
      });
    }
    const job = store.job("task");
    if (values.ready) store.updateBusiness({ ...store.business(job.releaseId), status: "ready" });
    if (values.stop) store.requestStop("task");
    if (values["emit-event"]) await emitEvent(directory, { id: `event-${job.id}`, type: "release.ready", taskId: job.id, releaseId: job.releaseId, revision: job.expectedRevision });
    const result = await run(runtime, { id: "task", model: { provider, model } }, { signal: controller.signal, waitMs: Number(values["wait-ms"] ?? (mode === "event" ? 0 : 60_000)) });
    console.log(JSON.stringify({ directory, result }, null, 2));
  } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); await runtime.close(); store.close(); }
}
