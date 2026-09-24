import { loop } from "@codesoul-co/ditto/runtime";
import { advance, begin, finish, limits, reason, revisionGraph, type Input, type Options, type Runner, type State } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";

export const boundedRound = revisionGraph("brief-bounded-round");
/** Fixed round: read checker feedback, repair one field, persist, independently check again. */
export async function runBounded(runtime: Runner, input: Input, options: Options = {}) {
  let state = await begin(runtime, input, options);
  if (!reason(state, input, 1)) state = await runtime.loop(loop({
    graph: boundedRound, maxIterations: limits(input).maxRounds,
    bind: (current: State) => ({ state: current, model: input.model }),
    update: advance,
    done: current => reason(current, input, 1) !== null,
  }), state, options);
  return finish(runtime, state, reason(state, input, 1), options);
}
if (isMain(import.meta.url)) await runCli(runBounded, "bounded");
