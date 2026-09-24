import { triggered, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
/** Wait for a persisted one-shot due time, then run the complete task. */
export async function runScheduled(runtime: Runner, input: Input, options: Options & { waitMs?: number; pollMs?: number } = {}) {
  return triggered(runtime, input, "time", options);
}
if (isMain(import.meta.url)) await runCli(runScheduled, "scheduled");
