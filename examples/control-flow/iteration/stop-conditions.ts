import { loop } from "@ditto/core/runtime";
import { advance, begin, finish, limits, reason, revisionGraph, type Input, type Options, type Runner, type State } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
const checkedRound = revisionGraph("brief-stop-check");
/** Reserve one Sample call before each round. The budget counts Sample nodes, not tokens or money. */
export async function runStopConditions(runtime: Runner, input: Input, options: Options = {}) {
  let state = await begin(runtime, input, options);
  if (!reason(state, input, 1)) state = await runtime.loop(loop({
    graph: checkedRound, maxIterations: limits(input).maxRounds,
    bind: (current: State) => ({ state: current, model: input.model }), update: advance,
    done: current => reason(current, input, 1) !== null,
  }), state, options);
  return finish(runtime, state, reason(state, input, 1), options);
}
if (isMain(import.meta.url)) await runCli(runStopConditions, "stop");
