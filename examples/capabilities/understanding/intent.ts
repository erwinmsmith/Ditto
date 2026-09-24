import { runUnderstanding, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
export async function runIntent(runtime: Runner, input: Input, options: Options = {}) {
  return runUnderstanding(runtime, input, "intent", options);
}
if (isMain(import.meta.url)) await runCli(runIntent, "intent");
