import { loop } from "@codesoul-co/ditto/runtime";
import { advance, begin, finish, limits, reason, revisionGraph, type Input, type Options, type Runner, type State } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
const checkedRound = revisionGraph("brief-goal-check");
/** An existing valid brief returns immediately; model self-assessment never decides completion. */
export async function runGoalCheck(runtime: Runner, input: Input, options: Options = {}) {
  let state = await begin(runtime, input, options);
  if (state.snapshot.complete) return finish(runtime, state, "goal", options);
  if (!reason(state, input, 1)) state = await runtime.loop(loop({
    graph: checkedRound, maxIterations: limits(input).maxRounds,
    bind: (current: State) => ({ state: current, model: input.model }), update: advance,
    done: current => current.snapshot.complete || reason(current, input, 1) !== null,
  }), state, options);
  return finish(runtime, state, reason(state, input, 1), options);
}
if (isMain(import.meta.url)) await runCli(runGoalCheck, "goal");
