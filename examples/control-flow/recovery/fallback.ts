import { action, fulfill, prepare, report, state, type Input, type Options, type Runner } from "./shared.ts";
import { isMain, runCli } from "./cli.ts";
/** Switch only an allowed read-only catalog source, and only for known availability failures. */
export async function runFallback(runtime: Runner, input: Input & { allowedSources?: readonly ("primary" | "backup")[] }, options: Options = {}) {
  const sources = input.allowedSources ?? ["primary", "backup"];
  if (!sources.length || new Set(sources).size !== sources.length || sources.some(source => !["primary", "backup"].includes(source))) throw new Error("Invalid fallback allowlist");
  const job = await prepare(runtime, input, options);
  if (["completed", "compensated", "rejected"].includes(job.stage)) return report(runtime, input.id, options);
  let code = "NO_AVAILABLE_SOURCE";
  for (const source of sources) {
    const result = await action(runtime, input.id, "recovery_catalog", { source }, options);
    if (result.status === "success") return fulfill(runtime, input, options);
    code = result.error?.code ?? "CATALOG_FAILED";
    if (code !== "UNAVAILABLE") break;
  }
  await state(runtime, input.id, "failed", code, options);
  return report(runtime, input.id, options);
}
if (isMain(import.meta.url)) await runCli(runFallback, "fallback");
