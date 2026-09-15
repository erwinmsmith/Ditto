import type { JsonObject, JsonValue } from "../../../contracts/common.js";
export type {
  ModelInput, ModelOutput, ModelProvider, ModelUsage, ProviderRequest,
  ProviderResolver, ToolCall, ToolDefinition,
} from "../../../contracts/common.js";

export function jsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
  return value as Record<string, JsonValue>;
}
