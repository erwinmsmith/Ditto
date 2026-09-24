import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { createOrderFiles } from "../../_shared/tools/order-files.ts";
import { validateBatch, validateOptions, type BatchInput, type ExecutionOptions, type Runner, type Source } from "./shared.ts";

export const isMain = (url: string) => !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
/** CLI setup only; the four example files retain their orchestration. */
export async function runCli(run: (runtime: Runner, input: BatchInput, options: ExecutionOptions) => Promise<unknown>, mode: { partial?: boolean } = {}) {
  const { values } = parseArgs({ options: { manifest: { type: "string" }, concurrency: { type: "string" } } });
  if (mode.partial && values.concurrency) throw new Error("Partial-result fan-out is capped at eight independent tasks; --concurrency configures a single Graph in the other examples");
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  if (!config.model) throw new Error("Configure the default model in .env");
  await mkdir(".examples-parallel-tasks", { recursive: true });
  const directory = await mkdtemp(resolve(".examples-parallel-tasks/cli-"));
  let sources: Source[], inputDirectory: string;
  if (values.manifest) {
    inputDirectory = dirname(resolve(values.manifest));
    const manifest = JSON.parse(await readFile(values.manifest, "utf8")) as { sources: Source[] };
    sources = manifest.sources.map(source => ({ ...source, path: resolve(inputDirectory, source.path) }));
  } else {
    inputDirectory = join(directory, "input"); await mkdir(inputDirectory);
    sources = [];
    for (let index = 0; index < 3; index++) {
      const id = `order-${index}`, path = join(inputDirectory, `${id}.txt`);
      if (!mode.partial || index !== 1) await writeFile(path, `Order code ORDER-${index}; quantity ${index + 1}; unit price ${100 + index * 50} cents.`);
      sources.push({ id, path, description: `Independent purchase order ${index}` });
    }
  }
  const input = { id: `batch-${randomUUID()}`, sources, model: config.model };
  const options = values.concurrency ? { concurrency: Number(values.concurrency) } : {};
  validateBatch(input); validateOptions(options);
  const adapter = createOrderFiles({ inputDirectory, outputDirectory: join(directory, "output") });
  const runtime = createDitto({ config, sandbox: { ...config.sandbox, tools: adapter.tools.map(tool => tool.name) }, workers: [
    createInferWorker(), createInteractionWorker({ tools: adapter.tools, output: adapter.output }),
  ] });
  try { const result = await run(runtime, input, options); console.log(JSON.stringify({ directory, result }, null, 2)); }
  finally { await runtime.close(); }
}
