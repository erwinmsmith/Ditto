import type { ModelSelection } from "../../runtime/config.js";
import type { WorkerContext } from "../execution-context.js";
import type { NodeHandler } from "../node.js";
import type { ToolSchema } from "./providers/index.js";
import type {} from "./contracts.js";

export interface GenerateNodeOptions<R = undefined, C = undefined> {
  readonly model?: ModelSelection;
  readonly tools?: (context: WorkerContext<R, C>) => readonly ToolSchema[];
}

export function createGenerateNode<R = undefined, C = undefined>(
  options: GenerateNodeOptions<R, C> = {},
): NodeHandler<"REASONING.GENERATE", R, C> {
  return async (input, ctx) => {
    const selection = options.model ?? ctx.services.config.model;
    if (!selection?.provider || !selection.model) throw new Error("No model selected");
    return ctx.services.providers.get(selection.provider).generate({
      model: selection.model, messages: input.messages, tools: options.tools?.(ctx) ?? [],
      signal: AbortSignal.timeout(ctx.services.config.timeoutMs),
    });
  };
}
