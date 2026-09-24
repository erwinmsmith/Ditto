import { runPlanning, type Runner, type Input, type Options } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
export const runTools = (runtime: Runner, input: Input, options: Options = {}) => runPlanning(runtime, input, "tools", options);
if (isMain(import.meta.url)) await runCli(runTools, "tools");
