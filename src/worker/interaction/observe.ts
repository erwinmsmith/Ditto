import { createNodeScaffold } from "../node-scaffold.js";
import type { MessagePart, Observation } from "../../contracts/common.js";
import type { InteractionObserveInput } from "./contracts.js";
import { externalResult } from "./validation.js";
export const interactionObserveNode = createNodeScaffold("INTERACTION.OBSERVE");

export function observeExternalResult({ result }: InteractionObserveInput): Observation {
  result = externalResult(result);
  const parts: MessagePart[] = [];
  if (result.status !== "success") parts.push({ type: "text", text: `${result.status}: ${result.error!.code}: ${result.error!.message}` });
  if (result.content !== undefined) {
    if (typeof result.content === "string") parts.push({ type: "text", text: result.content });
    else if (Array.isArray(result.content) && result.content.every(part => part && typeof part === "object" && "type" in part)) parts.push(...result.content as MessagePart[]);
    else parts.push({ type: "json", data: result.content as import("../../contracts/common.js").JsonValue });
  }
  if (result.structuredContent !== undefined) parts.push({ type: "json", data: result.structuredContent });
  for (const reference of result.references ?? []) parts.push({ type: "reference", reference });
  return {
    callId: result.callId, source: result.source, status: result.status,
    message: { role: "tool", name: result.source, content: parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts },
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    ...(result.references === undefined ? {} : { references: result.references }),
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
  };
}
