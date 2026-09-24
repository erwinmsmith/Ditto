import { runPlanning, type Runner, type Input, type Options } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
export const runPlan = (runtime: Runner, input: Input, options: Options = {}) => runPlanning(runtime, input, "plan", options);
if (isMain(import.meta.url)) await runCli(runPlan, "plan");
