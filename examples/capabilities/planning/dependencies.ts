import { runPlanning, type Runner, type Input, type Options } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
export const runDependencies = (runtime: Runner, input: Input, options: Options = {}) => runPlanning(runtime, input, "dependencies", options);
if (isMain(import.meta.url)) await runCli(runDependencies, "dependencies");
