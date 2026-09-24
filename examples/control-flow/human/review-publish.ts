import { advance, prepare, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
/** Publication uses the stored, reviewed bytes; no model rewrites content after approval. */
export async function runReviewPublish(runtime: Runner, input: Input, options: Options = {}) {
  return advance(runtime, input, await prepare(runtime, input, "publish", options), false, options);
}
if (isMain(import.meta.url)) await runCli(runReviewPublish, "publish");
