import { advance, prepare, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
/** Human approval covers the precise local activation payload and expected deployment state. */
export async function runApproval(runtime: Runner, input: Input, options: Options = {}) {
  return advance(runtime, input, await prepare(runtime, input, "approval", options), false, options);
}
if (isMain(import.meta.url)) await runCli(runApproval, "approval");
