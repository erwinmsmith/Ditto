import { runUnderstanding, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
export async function runConstraints(runtime: Runner, input: Input, options: Options = {}) {
  return runUnderstanding(runtime, input, "constraints", options);
}
if (isMain(import.meta.url)) await runCli(runConstraints, "constraints");
