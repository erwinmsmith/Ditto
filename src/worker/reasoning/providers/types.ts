import type { JsonObject, JsonValue } from "../../../contracts/index.js";

export interface ToolCall { readonly id: string; readonly name: string; readonly arguments: JsonObject }
export type ModelMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly role: "tool"; readonly content: string; readonly toolCallId: string };
export interface ToolSchema { readonly name: string; readonly description: string; readonly inputSchema: JsonObject }
export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ToolSchema[];
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}
export interface ModelResponse { readonly content: string; readonly toolCalls: readonly ToolCall[] }
export interface ModelProvider { generate(request: ModelRequest): Promise<ModelResponse> }

export function jsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
  return value as Record<string, JsonValue>;
}
