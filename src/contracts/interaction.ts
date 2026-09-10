import type { JsonObject } from "./json.js";
import type { Message } from "./message.js";

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

