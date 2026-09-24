import { fulfill, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
/** Reopen the application checkpoint, skip saved inference/reservation, reconcile unconfirmed writes. */
export async function runCheckpoint(runtime: Runner, input: Input, options: Options & { stopAfter?: "prepared" | "reserved" } = {}) {
  return fulfill(runtime, input, options);
}
if (isMain(import.meta.url)) await runCli(runCheckpoint, "checkpoint");
