import {
  runDataCode,
  type Runner,
  type Input,
  type Options,
} from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
export function run(runtime: Runner, input: Input, options: Options = {}) {
  if (input.request.mode !== "code-modification")
    throw new Error("Mode mismatch");
  return runDataCode(runtime, input, options);
}
if (isMain(import.meta.url)) await runCli("code-modification");
