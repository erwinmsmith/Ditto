import {
  runMultimodal,
  type Runner,
  type Input,
  type Options,
} from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
export function run(runtime: Runner, input: Input, options: Options = {}) {
  if (input.request.mode !== "chart-understanding")
    throw new Error("Mode mismatch");
  return runMultimodal(runtime, input, options);
}
if (isMain(import.meta.url)) await runCli("chart-understanding");
