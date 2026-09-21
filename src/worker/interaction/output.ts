import { createNodeScaffold } from "../node-scaffold.js";
import type { OutputReceipt } from "../../contracts/common.js";
import type { WorkerContext } from "../node.js";
import type { InteractionOutputInput } from "./contracts.js";
import { validateOutputInput, outputReceipt } from "./validation.js";
export const interactionOutputNode = createNodeScaffold("INTERACTION.OUTPUT");

export interface OutputSink {
  deliver(input: InteractionOutputInput, context: WorkerContext<unknown, unknown>): Promise<OutputReceipt>;
}

export function createOutputHandler<R = undefined, C = undefined>(sink: OutputSink): import("../node.js").NodeHandler<"INTERACTION.OUTPUT", R, C> {
  return async (input, context) => {
    validateOutputInput(input);
    const receipt = outputReceipt(await sink.deliver(input, context));
    if (receipt.deliveryId !== input.deliveryId) throw new Error("Output receipt deliveryId mismatch");
    return receipt;
  };
}
