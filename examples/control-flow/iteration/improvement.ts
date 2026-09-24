import { loop } from "@codesoul-co/ditto/runtime";
import { advance, begin, finish, limits, reason, revisionGraph, type Input, type Options, type Runner, type State } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
const improve = revisionGraph("brief-review-and-improve");
/** Each saved revision fixes one reviewer finding and keeps already correct fields. */
export async function runImprovement(runtime: Runner, input: Input, options: Options = {}) {
  let state = await begin(runtime, input, options);
  if (state.snapshot.missing.length) throw new Error("Improvement requires evidence for every required field");
  if (!reason(state, input, 1)) state = await runtime.loop(loop({
    graph: improve, maxIterations: limits(input).maxRounds,
    bind: (current: State) => ({ state: current, model: input.model }), update: advance,
    done: current => reason(current, input, 1) !== null,
  }), state, options);
  return finish(runtime, state, reason(state, input, 1), options);
}
if (isMain(import.meta.url)) await runCli(runImprovement, "improvement");
