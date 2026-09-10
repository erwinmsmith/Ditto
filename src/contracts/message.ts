import type { JsonValue } from "./json.js";

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

