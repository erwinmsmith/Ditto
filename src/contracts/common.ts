import type { NodeType } from "./node-contract-map.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = Readonly<Record<string, JsonValue>>;

export interface Reference {
  uri: string;
  mediaType?: string;
  digest?: string;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "json"; data: JsonValue }
  | { type: "reference"; reference: Reference };
export type MessageContent = string | JsonValue | readonly MessagePart[];
export interface Message {
  role: MessageRole;
  content: MessageContent;
  name?: string;
}

export interface ContextItem {
  id: string;
  content: MessageContent;
  source?: Reference;
  metadata?: JsonObject;
}
export interface Context { items: readonly ContextItem[]; }
export type ContextSource = Message | Reference | ContextItem;

export interface ContextIngress {
  id: string;
  sourceNode: NodeType;
  content: MessageContent;
  reference?: Reference;
  metadata?: JsonObject;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}
export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonObject;
  effects?: readonly ToolEffect[];
  requiresApproval?: boolean;
}
export type ToolEffect = "read" | "write" | "execute" | "network";
export interface ExternalResult {
  callId: string;
  source: string;
  status: ExternalResultStatus;
  content?: MessageContent;
  structuredContent?: JsonValue;
  references?: readonly Reference[];
  error?: InteractionError;
  metadata?: JsonObject;
}
export type ExternalResultStatus = "success" | "failed" | "cancelled" | "timeout" | "unknown";
export interface InteractionError { code: string; message: string; retryable?: boolean; }
export interface Observation extends Omit<ExternalResult, "content"> { message: Message; }
export interface Artifact { name: string; reference: Reference; }
export type OutputStatus = "accepted" | "rejected" | "unknown";
export interface OutputReceipt {
  deliveryId: string;
  status: OutputStatus;
  artifacts?: readonly Artifact[];
  error?: InteractionError;
  metadata?: JsonObject;
}
export interface McpCapability {
  server: string;
  name: string;
  description?: string;
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
}
