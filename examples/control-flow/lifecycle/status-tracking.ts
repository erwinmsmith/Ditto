import { execute, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
/** Track durable state transitions from queue to completion or failure. */
export async function runStatusTracking(runtime: Runner, input: Input, options: Options = {}) {
  return execute(runtime, input, options);
}
if (isMain(import.meta.url)) await runCli(runStatusTracking, "tracking");
