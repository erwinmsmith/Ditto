import { fulfill, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
/** Only a confirmed shipment rejection permits stock release; uncertain writes require reconciliation. */
export async function runCompensation(runtime: Runner, input: Input, options: Options = {}) {
  return fulfill(runtime, input, { ...options, compensate: true });
}
if (isMain(import.meta.url)) await runCli(runCompensation, "compensation");
