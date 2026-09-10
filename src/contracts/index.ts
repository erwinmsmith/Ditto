export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = Readonly<Record<string, JsonValue>>;

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Reference {
  uri: string;
  mediaType?: string;
}

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
}

export interface Context {
  items: readonly ContextItem[];
}

export type ContextSource = Message | Reference;

export interface MemoryDraft {
  message: Message;
}

export interface MemoryItem {
  id: string;
  message: Message;
}

export interface MemoryReference {
  id: string;
}

export interface Action {
  name: string;
  arguments: JsonObject;
}

export interface Observation {
  source: string;
  message: Message;
}

export interface Recipient {
  id: string;
  channel?: string;
}

export type * from "./node-contract-map.js";
