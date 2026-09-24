import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createContextWorker } from "@ditto/core/worker/context";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { RecoveryStore } from "../../_shared/tools/recovery-store.ts";
import { startFulfillmentService } from "../../_shared/tools/fulfillment-service.ts";
import { createFixture, type Fixture, type Mode } from "./fixtures.ts";
import { report, type Input, type Options, type Runner } from "./shared.ts";
export const isMain = (url: string) => !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
export async function runCli(run: (runtime: Runner, input: Input, options?: Options & { stopAfter?: "prepared" | "reserved" }) => Promise<unknown>, mode: Mode, resume?: (runtime: Runner, input: Input) => Promise<unknown>) {
  const { values } = parseArgs({ options: { directory: { type: "string" }, decision: { type: "string" }, actor: { type: "string" } } });
  if (values.decision && (mode !== "pause" || !values.directory || !values.actor?.trim() || !["approve", "reject"].includes(values.decision))) throw new Error("A resumed pause requires --decision approve|reject and --actor");
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  if (!config.model) throw new Error("Configure the default model in .env");
  await mkdir(".examples-recovery-tasks", { recursive: true });
  const directory = values.directory ? resolve(values.directory) : await mkdtemp(resolve(".examples-recovery-tasks/cli-"));
  const fixture: Fixture = values.directory ? JSON.parse(await readFile(join(directory, "fixture.json"), "utf8")) : await createFixture(directory, mode);
  const service = await startFulfillmentService(join(directory, "service.sqlite"), [{ sku: fixture.expected.sku, quantity: fixture.stock }], fixture.faults);
  const store = new RecoveryStore(directory, service.url);
  const runtime = createDitto({ config, sandbox: { ...config.sandbox, tools: store.tools.map(tool => tool.name), network: [...config.sandbox.network ?? [], service.url] }, workers: [
    createContextWorker(), createInferWorker(), createInteractionWorker({ tools: store.tools }),
  ] });
  try {
    if (!values.directory) await store.create("task", fixture.requiresApproval);
    if (values.decision) store.decide("task", values.decision as "approve" | "reject", values.actor!);
    const input = { id: "task", model: config.model };
    const result = mode === "pause" && store.job("task").approval
      ? await (resume ?? (() => { throw new Error("Resume handler required"); }))(runtime, input)
      : await run(runtime, input, mode === "checkpoint" && !values.directory ? { stopAfter: "reserved" } : {});
    const checkpoint = await report(runtime, "task");
    console.log(JSON.stringify({ directory, result, checkpoint }, null, 2));
  } finally { await runtime.close(); store.close(); await service.close(); }
}
