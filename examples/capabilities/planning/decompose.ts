import { runPlanning, type Runner, type Input, type Options } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
export const runDecomposition = (runtime: Runner, input: Input, options: Options = {}) => runPlanning(runtime, input, "decompose", options);
if (isMain(import.meta.url)) await runCli(runDecomposition, "decompose");
