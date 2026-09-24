import { triggered, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
/** Ingest a real file event, deduplicate it and run the complete task. */
export async function runEventTriggered(runtime: Runner, input: Input, options: Options & { waitMs?: number; pollMs?: number } = {}) {
  return triggered(runtime, input, "event", options);
}
if (isMain(import.meta.url)) await runCli(runEventTriggered, "event");
