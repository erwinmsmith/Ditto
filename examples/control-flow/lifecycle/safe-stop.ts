import { execute, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
/** Stop on cancellation, deadline, model-call budget or an application stop request. */
export async function runSafeStop(runtime: Runner, input: Input, options: Options = {}) {
  return execute(runtime, input, options);
}
if (isMain(import.meta.url)) await runCli(runSafeStop, "stop");
