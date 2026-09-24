import { action, fulfill, prepare, report, state, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
/** The deadline covers the read operation; caller cancellation remains an exception. */
export async function runTimeout(runtime: Runner, input: Input & { timeoutMs?: number }, options: Options = {}) {
  const timeoutMs = input.timeoutMs ?? 75;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Invalid timeout");
  const job = await prepare(runtime, input, options);
  if (["completed", "compensated", "rejected"].includes(job.stage)) return report(runtime, input.id, options);
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    const result = await action(runtime, input.id, "recovery_catalog", { source: "primary" }, { signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline });
    if (result.status !== "success") {
      await state(runtime, input.id, "failed", result.error?.code ?? "CATALOG_FAILED", options);
      return report(runtime, input.id, options);
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (!deadline.aborted) throw error;
    await state(runtime, input.id, "timed-out", "CATALOG_TIMEOUT", options);
    return report(runtime, input.id, options);
  }
  return fulfill(runtime, input, options);
}
if (isMain(import.meta.url)) await runCli(runTimeout, "timeout");
