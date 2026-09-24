import { runRetrieval, type Runner, type Input, type Options } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
export function run(runtime: Runner, input: Input, options: Options = {}) {
  if (input.request.mode !== "expand") throw new Error("Request mode mismatch");
  return runRetrieval(runtime, input, options);
}
if (isMain(import.meta.url)) await runCli("expand");
