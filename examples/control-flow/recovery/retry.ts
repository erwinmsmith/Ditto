import { loop } from "@codesoul-co/ditto/runtime";
import type { ExternalResult } from "@codesoul-co/ditto/contracts";
import { fulfill, prepare, read, report, sourceGraph, state, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
interface RetryState { attempt: number; maxBytes: number; retry: boolean; result: ExternalResult | null }
/** SOURCE_TOO_LARGE permits a bounded byte-limit adjustment; missing/changed sources never retry. */
export async function runRetry(runtime: Runner, input: Input & { initialMaxBytes?: number; maxAttempts?: number }, options: Options = {}) {
  const maxAttempts = input.maxAttempts ?? 3, maxBytes = input.initialMaxBytes ?? 16;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536) throw new Error("Invalid retry limits");
  if ((await read(runtime, input.id, options)).stage !== "queued") return fulfill(runtime, input, options);
  const initial: RetryState = { attempt: 0, maxBytes, retry: true, result: null };
  const result = await runtime.loop(loop({ graph: sourceGraph, maxIterations: maxAttempts,
    bind: (current: RetryState) => ({ ...input, maxBytes: current.maxBytes }),
    update: (current, { source }): RetryState => {
      const required = Number(source.metadata?.requiredBytes);
      const retry = source.status === "failed" && source.error?.code === "SOURCE_TOO_LARGE" && source.error.retryable === true
        && Number.isSafeInteger(required) && required > current.maxBytes && required <= 65536;
      return { attempt: current.attempt + 1, maxBytes: retry ? required : current.maxBytes, retry, result: source };
    }, done: current => !current.retry || current.attempt >= maxAttempts,
  }), initial, options);
  if (result.result!.status !== "success") {
    await state(runtime, input.id, "failed", result.result!.error?.code ?? "SOURCE_FAILED", options);
    return report(runtime, input.id, options);
  }
  await prepare(runtime, input, options, result.result!);
  return fulfill(runtime, input, options);
}
if (isMain(import.meta.url)) await runCli(runRetry, "retry");
