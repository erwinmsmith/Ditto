import { execute, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
/** Check business readiness and revision before inference and atomic registration. */
export async function runStateCheck(runtime: Runner, input: Input, options: Options = {}) {
  return execute(runtime, input, options);
}
if (isMain(import.meta.url)) await runCli(runStateCheck, "state");
