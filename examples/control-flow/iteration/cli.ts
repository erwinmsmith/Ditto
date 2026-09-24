import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { createBriefFiles } from "../../_shared/tools/brief-files.ts";
import { createFixture, type Mode } from "./fixtures.ts";
import type { Input, Options, Runner } from "./shared.ts";
export const isMain = (url: string) => !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
export async function runCli(run: (runtime: Runner, input: Input, options?: Options) => Promise<unknown>, mode: Mode) {
  const { values } = parseArgs({ options: { input: { type: "string" }, "max-rounds": { type: "string" }, "model-call-budget": { type: "string" } } });
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  if (!config.model) throw new Error("Configure the default model in .env");
  await mkdir(".examples-iteration-tasks", { recursive: true });
  const directory = await mkdtemp(resolve(".examples-iteration-tasks/cli-"));
  const inputDirectory = values.input ? resolve(values.input) : join(directory, "input");
  if (!values.input) await createFixture(inputDirectory, mode);
  const adapter = createBriefFiles({ inputDirectory, outputDirectory: join(directory, "output") });
  const runtime = createDitto({ config, sandbox: { ...config.sandbox, tools: adapter.tools.map(tool => tool.name) }, workers: [
    createInferWorker(), createInteractionWorker({ tools: adapter.tools }),
  ] });
  try {
    const result = await run(runtime, { model: config.model,
      ...(values["max-rounds"] === undefined ? {} : { maxRounds: Number(values["max-rounds"]) }),
      ...(values["model-call-budget"] === undefined ? mode === "stop" ? { modelCallBudget: 1 } : {} : { modelCallBudget: Number(values["model-call-budget"]) }),
    });
    console.log(JSON.stringify({ directory, result }, null, 2));
  } finally { await runtime.close(); }
}
