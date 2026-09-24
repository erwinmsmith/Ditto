import {
  runValidation,
  type Runner,
  type Input,
  type Options,
} from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
export function run(runtime: Runner, input: Input, options: Options = {}) {
  if (input.request.mode !== "permissions") throw new Error("Mode mismatch");
  return runValidation(runtime, input, options);
}
if (isMain(import.meta.url)) await runCli("permissions");
