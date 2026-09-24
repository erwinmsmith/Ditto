import { loop } from "@ditto/core/runtime";
import { advance, begin, finish, limits, planningGraph, reason, revisionGraph, searchGraph, type Input, type Options, type Runner, type State } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
const repair = revisionGraph("brief-adaptive-repair");
export const nextCost = (state: State) => state.next?.kind === "search" ? 0 : 1;
/** A validated model plan selects the next native Graph; failed lookups change the next plan. */
export async function runAdaptive(runtime: Runner, input: Input, options: Options = {}) {
  let state = await begin(runtime, input, options);
  if (!reason(state, input, nextCost(state))) state = await runtime.loop(loop({
    graph: (current: State) => current.next === null ? planningGraph : current.next.kind === "search" ? searchGraph : repair,
    maxIterations: limits(input).maxRounds,
    bind: (current: State) => ({ state: current, model: input.model }),
    update: advance,
    done: current => reason(current, input, nextCost(current)) !== null,
  }), state, options);
  return finish(runtime, state, reason(state, input, nextCost(state)), options);
}
if (isMain(import.meta.url)) await runCli(runAdaptive, "adaptive");
