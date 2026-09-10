import type { Message, MessageContent, Reference } from "./message.js";

export interface ContextItem {
  id: string;
  content: MessageContent;
}

export interface Context {
  items: readonly ContextItem[];
}

export type ContextSource = Message | Reference;

