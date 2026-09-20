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

export type ContextIngressSource =
  | "MEMORY.SKILL"
  | "CONTEXT.RAG.RANK"
  | "MEMORY.RAG.RANK"
  | "INTERACTION.OBSERVE";
export interface ContextIngress {
  id: string;
  sourceNode: ContextIngressSource;
  content: MessageContent;
  reference?: Reference;
  metadata?: JsonObject;
}

export interface MemoryDraft {
  key?: string;
  message: Message;
  metadata?: JsonObject;
}
export interface MemoryItem extends MemoryDraft { id: string; }
export interface MemoryReference { id: string; }
export interface MemorySelector {
  ids?: readonly string[];
  keys?: readonly string[];
  filter?: JsonObject;
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
export interface KnowledgeItem {
  id: string;
  content: MessageContent;
  source?: Reference;
  metadata?: JsonObject;
}
export interface EmbeddingRecord { itemId: string; vector: readonly number[]; }
export interface RagCandidate { item: KnowledgeItem; score?: number; }
export interface MemoryRagCandidate { memory: MemoryItem; score?: number; }
export interface Skill {
  name: string;
  version?: string;
  description?: string;
  instructions: MessageContent;
  metadata?: JsonObject;
}

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
