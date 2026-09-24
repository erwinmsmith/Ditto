import { graph } from "@ditto/core/runtime";
import { toJsonObject, type OrderFailure } from "../../_shared/tools/order-files.ts";
import { runCli, isMain } from "./cli.ts";
import { accepted, deliveryInput, orderGraph, OrderTaskError, savedOrder, toolData, validateBatch, type BatchInput, type Runner } from "./shared.ts";

const partialReportGraph = graph<{ id: string; successIds: string[]; failures: OrderFailure[] }>("partial-order-report")
  .node("report", "INTERACTION.ACT.TOOL", [], input => ({ call: {
    id: `${input.id}:report`, name: "build_order_report", arguments: toJsonObject({ batchId: input.id, successIds: input.successIds, failures: input.failures }),
  } }))
  .node("delivered", "INTERACTION.OUTPUT", ["report"], (input, { report }) => deliveryInput(input.id, report));

/** Each source owns an isolated Graph. allSettled retains every completed task despite sibling rejection. */
export async function runPartial(runtime: Runner, input: BatchInput, options: { readonly signal?: AbortSignal } = {}) {
  validateBatch(input); options.signal?.throwIfAborted();
  const settled = await Promise.allSettled(input.sources.map(async source => {
    const output = await runtime.run(orderGraph, { batchId: input.id, source, model: input.model }, { concurrency: 1, ...options });
    return savedOrder(output.saved);
  }));
  // Cancellation is not a normal partial success; all started work has settled before this check.
  options.signal?.throwIfAborted();
  const orders = [], failures: OrderFailure[] = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === "fulfilled") orders.push(result.value);
    else failures.push({ sourceId: input.sources[index]!.id,
      code: result.reason instanceof OrderTaskError ? result.reason.code : "TASK_EXECUTION_FAILED",
      message: result.reason instanceof OrderTaskError ? result.reason.message : "Order task could not be completed",
    });
  }
  const output = await runtime.run(partialReportGraph, { id: input.id, successIds: orders.map(order => order.sourceId), failures }, options);
  accepted(output.delivered);
  return { orders, failures, report: toolData(output.report), receipt: output.delivered };
}
if (isMain(import.meta.url)) await runCli((runtime, input, options) => runPartial(runtime, input, options), { partial: true });
