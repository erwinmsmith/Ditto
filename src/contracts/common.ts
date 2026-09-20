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
  | "CONTEXT.SKILL"
  | "CONTEXT.RAG.RANK"
  | "MEMORY.SEARCH"
  | "INTERACTION.ACT.TOOL"
  | "INTERACTION.ACT.MCP";
export interface ContextIngress {
  id: string;
  sourceNode: ContextIngressSource;
  content: MessageContent;
  reference?: Reference;
  metadata?: JsonObject;
}

export interface ToolCall {
  id?: string;
  name: string;
  arguments: JsonObject;
}
export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonObject;
}
export interface KnowledgeItem {
  id: string;
  content: MessageContent;
  source?: Reference;
  metadata?: JsonObject;
}
export interface EmbeddingRecord { itemId: string; vector: readonly number[]; }
export interface RagCandidate { item: KnowledgeItem; score?: number; }
export interface Skill {
  name: string;
  version?: string;
  description?: string;
  instructions: MessageContent;
  metadata?: JsonObject;
}

export interface ExternalResult {
  source: string;
  content: MessageContent;
  reference?: Reference;
  metadata?: JsonObject;
}
export interface Observation { source: string; message: Message; }
export interface Artifact { name: string; reference: Reference; }
export interface OutputReceipt { accepted: boolean; artifacts?: readonly Artifact[]; }
export interface McpCapability {
  server: string;
  name: string;
  description?: string;
  inputSchema?: JsonObject;
}
