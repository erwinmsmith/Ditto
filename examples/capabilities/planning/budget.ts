import { runPlanning, type Runner, type Input, type Options } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
export const runBudget = (runtime: Runner, input: Input, options: Options = {}) => runPlanning(runtime, input, "budget", options);
if (isMain(import.meta.url)) await runCli(runBudget, "budget");
