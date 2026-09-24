import { advance, prepare, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
/** Display the provisional notice; only after confirmation generate the private calendar artifact. */
export async function runIntermediate(runtime: Runner, input: Input, options: Options = {}) {
  return advance(runtime, input, await prepare(runtime, input, "intermediate", options), true, options);
}
if (isMain(import.meta.url)) await runCli(runIntermediate, "intermediate");
