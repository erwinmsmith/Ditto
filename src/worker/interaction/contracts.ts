import type { JsonObject, JsonValue, Message } from "../../contracts/common.js";
import type { ModelMessage } from "../reasoning/providers/index.js";
import type { Skill } from "./skills.js";

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

export interface InteractionRunInput { readonly messages: readonly ModelMessage[]; readonly skills?: readonly string[] }
export interface InteractionRunOutput { readonly content: string; readonly messages: readonly ModelMessage[]; readonly turns: number }

declare module "../../contracts/node-contract-map.js" {
  interface NodeContractMap {
    "INTERACTION.RUN": NodeContract<InteractionRunInput, InteractionRunOutput>;
    "INTERACTION.TOOL": NodeContract<{ readonly name: string; readonly arguments: JsonObject }, JsonValue>;
    "INTERACTION.SKILL": NodeContract<{ readonly name: string }, Skill>;
  }
}

export interface InteractionActInput {
  action: Action;
}
export type InteractionActOutput = Message;

export interface InteractionObserveInput {
  observation: Observation;
}
export type InteractionObserveOutput = Message;

export interface InteractionCommunicateInput {
  message: Message;
  recipients: readonly Recipient[];
}
export type InteractionCommunicateOutput = Message;

export interface InteractionOutputInput {
  message: Message;
}
export type InteractionOutputOutput = Message;
