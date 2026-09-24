import { fulfill, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
/** Every unconfirmed operation is looked up by its stable key before any attempt or retry. */
export async function runSideEffectCheck(runtime: Runner, input: Input, options: Options = {}) {
  return fulfill(runtime, input, options);
}
if (isMain(import.meta.url)) await runCli(runSideEffectCheck, "side-effect");
