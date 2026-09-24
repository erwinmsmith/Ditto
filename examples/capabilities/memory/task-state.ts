import { runMemory, type Runner, type Input, type Options } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
export function run(runtime: Runner, input: Input, options: Options = {}) {
  if (input.request.mode !== "task-state") throw new Error("Request mode mismatch");
  return runMemory(runtime, input, options);
}
if (isMain(import.meta.url)) await runCli("task-state");
