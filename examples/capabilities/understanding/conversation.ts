import { runUnderstanding, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
export async function runConversation(runtime: Runner, input: Input, options: Options = {}) {
  return runUnderstanding(runtime, input, "conversation", options);
}
if (isMain(import.meta.url)) await runCli(runConversation, "conversation");
