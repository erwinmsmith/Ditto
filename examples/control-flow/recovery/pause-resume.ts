import { fulfill, prepare, read, report, state, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
/** Persist a pause before external writes; the application records an authenticated user's decision. */
export async function runPause(runtime: Runner, input: Input, options: Options = {}) {
  const job = await prepare(runtime, input, options);
  if (!job.requiresApproval) throw new Error("Create this task with requiresApproval enabled");
  if (job.stage === "prepared") await state(runtime, input.id, "paused", null, options);
  return report(runtime, input.id, options);
}
export async function resumePaused(runtime: Runner, input: Input, options: Options = {}) {
  const job = await read(runtime, input.id, options);
  if (job.stage === "rejected" || job.stage === "paused") return report(runtime, input.id, options);
  if (!job.approval || job.approval.decision !== "approve") throw new Error("A persisted approval is required");
  return fulfill(runtime, input, options);
}
if (isMain(import.meta.url)) await runCli(runPause, "pause", resumePaused);
