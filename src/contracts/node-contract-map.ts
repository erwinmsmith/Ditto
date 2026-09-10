import type {
  Action, Context, ContextItem, ContextSource, MemoryDraft, MemoryItem, MemoryReference,
  Message, Observation, Recipient,
} from "./index.js";

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

export interface MemoryRetrieveInput {
  query: Message;
}
export type MemoryRetrieveOutput = readonly MemoryItem[];

export interface MemoryWriteInput {
  memories: readonly MemoryDraft[];
}
export type MemoryWriteOutput = readonly MemoryItem[];

export interface MemoryUpdateInput {
  memories: readonly MemoryItem[];
}
export type MemoryUpdateOutput = readonly MemoryItem[];

export interface MemoryConsolidateInput {
  memories: readonly MemoryItem[];
}
export type MemoryConsolidateOutput = readonly MemoryItem[];

export interface MemoryEvictInput {
  memories: readonly MemoryReference[];
}
export type MemoryEvictOutput = readonly MemoryReference[];

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

export interface NodeContract<TInput, TOutput> {
  input: TInput;
  output: TOutput;
}

export interface NodeContractMap {
  "REASONING.INFER": NodeContract<InferInput, InferOutput>;
  "REASONING.DELIBERATE": NodeContract<DeliberateInput, DeliberateOutput>;
  "REASONING.REFLECT": NodeContract<ReflectInput, ReflectOutput>;
  "REASONING.SAMPLE": NodeContract<SampleInput, SampleOutput>;
  "CONTEXT.LOAD": NodeContract<ContextLoadInput, ContextLoadOutput>;
  "CONTEXT.SELECT": NodeContract<ContextSelectInput, ContextSelectOutput>;
  "CONTEXT.UPDATE": NodeContract<ContextUpdateInput, ContextUpdateOutput>;
  "CONTEXT.COMPRESS": NodeContract<ContextCompressInput, ContextCompressOutput>;
  "CONTEXT.RESET": NodeContract<ContextResetInput, ContextResetOutput>;
  "MEMORY.RETRIEVE": NodeContract<MemoryRetrieveInput, MemoryRetrieveOutput>;
  "MEMORY.WRITE": NodeContract<MemoryWriteInput, MemoryWriteOutput>;
  "MEMORY.UPDATE": NodeContract<MemoryUpdateInput, MemoryUpdateOutput>;
  "MEMORY.CONSOLIDATE": NodeContract<MemoryConsolidateInput, MemoryConsolidateOutput>;
  "MEMORY.EVICT": NodeContract<MemoryEvictInput, MemoryEvictOutput>;
  "INTERACTION.ACT": NodeContract<InteractionActInput, InteractionActOutput>;
  "INTERACTION.OBSERVE": NodeContract<
    InteractionObserveInput,
    InteractionObserveOutput
  >;
  "INTERACTION.COMMUNICATE": NodeContract<
    InteractionCommunicateInput,
    InteractionCommunicateOutput
  >;
  "INTERACTION.OUTPUT": NodeContract<
    InteractionOutputInput,
    InteractionOutputOutput
  >;
}

export type L2NodeType = keyof NodeContractMap;

export type InputOf<TNode extends L2NodeType> =
  NodeContractMap[TNode]["input"];

export type OutputOf<TNode extends L2NodeType> =
  NodeContractMap[TNode]["output"];

