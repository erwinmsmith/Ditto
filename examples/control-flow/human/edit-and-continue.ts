import { advance, prepare, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
/** Human edits create a new version; the downstream model and calendar use that confirmed version. */
export async function runEditContinue(runtime: Runner, input: Input, options: Options = {}) {
  return advance(runtime, input, await prepare(runtime, input, "edit", options), true, options);
}
if (isMain(import.meta.url)) await runCli(runEditContinue, "edit");
