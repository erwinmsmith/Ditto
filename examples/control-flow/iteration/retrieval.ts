import { loop } from "@codesoul-co/ditto/runtime";
import { advance, begin, finish, limits, reason, retrievalGraph, revisionGraph, type Input, type Options, type Runner, type State } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
const compose = revisionGraph("brief-compose-from-evidence", true);
/** Re-query only unresolved evidence, then produce and verify a brief from the collected sources. */
export async function runRetrieval(runtime: Runner, input: Input, options: Options = {}) {
  let state = await begin(runtime, input, options);
  if (state.snapshot.missing.length && !reason(state, input, 1)) state = await runtime.loop(loop({
    graph: retrievalGraph, maxIterations: limits(input).maxRounds,
    bind: (current: State) => ({ state: current, model: input.model }), update: advance,
    done: current => current.snapshot.missing.length === 0 || reason(current, input, 1) !== null,
  }), state, options);
  // Evidence coverage is an intermediate goal; it is never presented as a completed brief.
  if (!state.snapshot.missing.length && !reason(state, input, 1)) {
    state = advance(state, await runtime.run(compose, { state, model: input.model }, options));
  }
  // A bad final composition remains an incomplete task; bounded revisions use the same checker.
  if (!reason(state, input, 1)) state = await runtime.loop(loop({
    graph: compose, maxIterations: limits(input).maxRounds - state.rounds,
    bind: (current: State) => ({ state: current, model: input.model }), update: advance,
    done: current => reason(current, input, 1) !== null,
  }), state, options);
  return finish(runtime, state, reason(state, input, 1), options);
}
if (isMain(import.meta.url)) await runCli(runRetrieval, "retrieval");
