import type { Message } from "../../contracts/common.js";
import type { ModelMessage, ModelResponse } from "./providers/index.js";

/** Tool-aware generation is distinct from the original Message-only INFER. */
export interface GenerateInput { readonly messages: readonly ModelMessage[] }
export type GenerateOutput = ModelResponse;

declare module "../../contracts/node-contract-map.js" {
  interface NodeContractMap {
    "REASONING.GENERATE": NodeContract<GenerateInput, GenerateOutput>;
  }
}

export interface InferInput {
  messages: readonly Message[];
}
export type InferOutput = Message;

export interface DeliberateInput {
  messages: readonly Message[];
}
export type DeliberateOutput = Message;

export interface ReflectInput {
  message: Message;
  context?: readonly Message[];
}
export type ReflectOutput = Message;

export interface SampleInput {
  messages: readonly Message[];
  count: number;
}
export type SampleOutput = readonly Message[];
