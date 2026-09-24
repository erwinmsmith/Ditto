import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createContextWorker } from "@ditto/core/worker/context";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { HumanReviewStore, draft, type HumanMode, type ReviewerPolicy } from "../../_shared/tools/human-review-store.ts";
import { createFixture, reviewers } from "./fixtures.ts";
import type { HumanResult, Input, Options, Runner } from "./shared.ts";
export const isMain = (url: string) => !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
export async function runCli(run: (runtime: Runner, input: Input, options?: Options) => Promise<HumanResult>, mode: HumanMode) {
  const { values } = parseArgs({ options: {
    directory: { type: "string" }, decision: { type: "string" }, edit: { type: "string" }, claim: { type: "boolean" }, actor: { type: "string" },
    request: { type: "string" }, token: { type: "string" }, note: { type: "string" }, provider: { type: "string" },
  } });
  const actions = Number(!!values.decision) + Number(!!values.edit) + Number(!!values.claim);
  if (actions > 1 || (actions && (!values.directory || !values.actor || !values.request || !values.token))) throw new Error("One human action requires --directory, --actor, --request and --token");
  if (values.decision && !["approve", "reject"].includes(values.decision)) throw new Error("Use --decision approve|reject");
  if ((values.edit || values.claim) && !values.note?.trim()) throw new Error("Editing and assignment require --note");
  const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider]) throw new Error("Configure a model provider");
  const modelName = config.providers[provider].model ?? (provider === config.model?.provider ? config.model.model : undefined);
  if (!modelName) throw new Error("Configure a model");
  await mkdir(".examples-human-tasks", { recursive: true });
  const directory = values.directory ? resolve(values.directory) : await mkdtemp(resolve(".examples-human-tasks/cli-"));
  let policy = reviewers;
  if (!values.directory) await createFixture(directory, mode);
  else {
    const application = JSON.parse(await readFile(resolve(directory, "application.json"), "utf8")) as { mode: HumanMode; reviewers: ReviewerPolicy };
    if (application.mode !== mode) throw new Error("Directory belongs to a different workflow");
    policy = application.reviewers;
  }
  const store = new HumanReviewStore(directory, policy);
  const runtime = createDitto({ config, sandbox: { ...config.sandbox, tools: store.tools.map(tool => tool.name) }, workers: [
    createContextWorker(), createInferWorker(), createInteractionWorker({ tools: store.tools, output: store.output }),
  ] });
  try {
    if (!values.directory) await store.create("task", mode);
    if (values.decision) store.decide({ requestId: values.request!, expectedToken: values.token!, choice: values.decision as "approve" | "reject", actor: values.actor!, ...(values.note ? { note: values.note } : {}) });
    if (values.edit) store.edit({ requestId: values.request!, expectedToken: values.token!, replacement: draft(JSON.parse(await readFile(resolve(values.edit), "utf8"))), actor: values.actor!, note: values.note! });
    if (values.claim) store.claim({ requestId: values.request!, expectedToken: values.token!, actor: values.actor!, note: values.note! });
    const result = await run(runtime, { id: "task", model: { provider, model: modelName } });
    console.log(JSON.stringify({ directory, result }, null, 2));
  } finally { await runtime.close(); store.close(); }
}
