import { ModelTaskError, prepare, present, report, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
/** Conflicting sources or unusable model output produce a persisted handoff with existing evidence. */
export async function runEscalation(runtime: Runner, input: Input, options: Options = {}) {
  try {
    const prepared = await prepare(runtime, input, "escalation", options);
    if (prepared.job.stage === "escalated" && prepared.request?.delivered) return report(runtime, input.id, options);
    return present(runtime, input.id, options);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (!(error instanceof ModelTaskError)) throw error;
    return present(runtime, input.id, options, error.code);
  }
}
if (isMain(import.meta.url)) await runCli(runEscalation, "escalation");
