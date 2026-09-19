import { createNodeScaffold } from "../../../node-scaffold.js";
import type { ToolRegistry } from "./registry.js";

export const interactionToolNode = createNodeScaffold("INTERACTION.ACT.TOOL");

export function createToolHandler<R = undefined, C = undefined>(
  registry: ToolRegistry,
): import("../../../node.js").NodeHandler<"INTERACTION.ACT.TOOL", R, C> {
  return (input, context) => registry.call(input.call, context);
}
