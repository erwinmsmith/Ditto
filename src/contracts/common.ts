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
  | "INTERACTION.ACT.TOOL"
  | "INTERACTION.ACT.MCP";
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

export interface ModelInput {
  messages: readonly Message[];
  context?: Context;
  responseFormat?: JsonObject;
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
export interface ModelUsage { inputTokens?: number; outputTokens?: number; }
export interface ModelOutput {
  message: Message;
  toolCalls?: readonly ToolCall[];
  finishReason?: string;
  usage?: ModelUsage;
}
export interface ReasoningBudget { maxSteps?: number; maxTokens?: number; }
export interface ReasoningTraceEvent {
  step: number;
  kind: string;
  summary?: string;
  references?: readonly Reference[];
}

export interface ProviderRequest {
  model: string;
  input: ModelInput;
  tools?: readonly ToolDefinition[];
  maxTokens?: number;
  signal?: AbortSignal;
}
export interface ModelProvider {
  invoke(request: ProviderRequest): Promise<ModelOutput>;
}
export interface ProviderResolver { get(name: string): ModelProvider; }

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
  source: string;
  content: MessageContent;
  reference?: Reference;
  metadata?: JsonObject;
}
export interface Observation { source: string; message: Message; }
export type ActorKind = "user" | "agent" | "human-reviewer" | "service";
export interface Actor { id: string; kind: ActorKind; channel?: string; }
export interface CommunicationReceipt {
  accepted: boolean;
  recipients: readonly string[];
}
export interface Artifact { name: string; reference: Reference; }
export interface OutputReceipt { accepted: boolean; artifacts?: readonly Artifact[]; }
export interface McpCapability {
  server: string;
  name: string;
  description?: string;
  inputSchema?: JsonObject;
}
