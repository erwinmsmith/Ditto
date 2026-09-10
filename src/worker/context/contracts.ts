import type { Message, MessageContent, Reference } from "../../contracts/common.js";

export interface ContextItem {
  id: string;
  content: MessageContent;
}

export interface Context {
  items: readonly ContextItem[];
}

export type ContextSource = Message | Reference;

export interface ContextLoadInput {
  sources: readonly ContextSource[];
}
export type ContextLoadOutput = Context;

export interface ContextSelectInput {
  context: Context;
  query: Message;
}
export type ContextSelectOutput = Context;

export interface ContextUpdateInput {
  context: Context;
  items: readonly ContextItem[];
}
export type ContextUpdateOutput = Context;

export interface ContextCompressInput {
  context: Context;
}
export type ContextCompressOutput = Context;

export interface ContextResetInput {
  context: Context;
}
export type ContextResetOutput = Context;


declare module "../../contracts/node-contract-map.js" {
  interface NodeContractMap {
    "CONTEXT.LOAD": NodeContract<ContextLoadInput, ContextLoadOutput>;
    "CONTEXT.SELECT": NodeContract<ContextSelectInput, ContextSelectOutput>;
    "CONTEXT.UPDATE": NodeContract<ContextUpdateInput, ContextUpdateOutput>;
    "CONTEXT.COMPRESS": NodeContract<ContextCompressInput, ContextCompressOutput>;
    "CONTEXT.RESET": NodeContract<ContextResetInput, ContextResetOutput>;
  }
}
