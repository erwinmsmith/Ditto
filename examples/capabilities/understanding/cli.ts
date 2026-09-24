import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { openUnderstandingStorage } from "./storage.ts";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { UnderstandingStore, type Mode, type Session } from "../../_shared/tools/understanding-store.ts";
import { createFixture } from "./fixtures.ts";
import type { Input, Options, Runner } from "./shared.ts";
export const isMain = (url: string) => !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
export async function runCli(run: (runtime: Runner, input: Input, options?: Options) => Promise<Session>, mode: Mode) {
  const { values } = parseArgs({ options: { directory: { type: "string" }, message: { type: "string" }, "message-id": { type: "string" }, revision: { type: "string" }, token: { type: "string" }, choice: { type: "string" }, provider: { type: "string" } } });
  if (values.message && values.choice) throw new Error("Submit either a message or a choice");
  if (values.directory && (values.message || values.choice) && values.revision === undefined) throw new Error("Replies require --revision");
  if (values.directory && values.message && !values["message-id"]) throw new Error("Replies require --message-id for deduplication");
  if (values.choice && (!values.directory || !values.token)) throw new Error("Selection requires an existing --directory and --token");
  const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider]) throw new Error("Configure a provider"); const model = config.providers[provider].model ?? config.model?.model; if (!model) throw new Error("Configure a model");
  await mkdir(".examples-understanding-tasks", { recursive: true });
  const directory = values.directory ? resolve(values.directory) : await mkdtemp(resolve(".examples-understanding-tasks/cli-"));
  const fixture = !values.directory ? await createFixture(directory, mode) : null;
  if (values.directory && JSON.parse(await readFile(resolve(directory, "application.json"), "utf8")).mode !== mode) throw new Error("Directory belongs to another example");
  const store = new UnderstandingStore(directory), controller = new AbortController(); const cancel = () => controller.abort(); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const storage = await openUnderstandingStorage(directory, config);
  const runtime = createDitto({ config, sandbox: { ...config.sandbox, tools: store.tools.map(t => t.name) }, workers: [...storage.workers, createInferWorker(), createInteractionWorker({ tools: store.tools, output: store.output })] });
  try {
    if (fixture) await store.create("session", mode, values.message ?? fixture.message);
    else if (values.message) store.receive({ id: "session", messageId: values["message-id"]!, text: values.message, expectedRevision: Number(values.revision), ...(values.token ? { replyToken: values.token } : {}) });
    if (values.choice) store.choose({ id: "session", expectedRevision: Number(values.revision), token: values.token!, choiceId: values.choice });
    const result = await run(runtime, { id: "session", model: { provider, model } }, { signal: controller.signal }); console.log(JSON.stringify({ directory, result }, null, 2));
  } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); await runtime.close(); await storage.close(); store.close(); }
}
