// Generated from docs/13-node-api-contract.md; keep the reviewed API independent of implementation.
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = Readonly<Record<string, JsonValue>>;

export type MessageRole =
  | "system"
  | "user"
  | "assistant"
  | "tool";

export interface Reference {
  uri: string;
  mediaType?: string;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "json"; data: JsonValue }
  | { type: "reference"; reference: Reference };

export type MessageContent =
  | string
  | JsonValue
  | readonly MessagePart[];

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
  "INTERACTION.OBSERVE": NodeContract<InteractionObserveInput, InteractionObserveOutput>;
  "INTERACTION.COMMUNICATE": NodeContract<
    InteractionCommunicateInput,
    InteractionCommunicateOutput
  >;
  "INTERACTION.OUTPUT": NodeContract<InteractionOutputInput, InteractionOutputOutput>;
}

export type L2NodeType = keyof NodeContractMap;

export type InputOf<TNode extends L2NodeType> =
  NodeContractMap[TNode]["input"];

export type OutputOf<TNode extends L2NodeType> =
  NodeContractMap[TNode]["output"];

export abstract class BaseNode<TNode extends L2NodeType> {
  abstract readonly type: TNode;

  abstract execute(
    input: InputOf<TNode>,
  ): Promise<OutputOf<TNode>>;
}

export abstract class InferNode
  extends BaseNode<"REASONING.INFER"> {}

export abstract class DeliberateNode
  extends BaseNode<"REASONING.DELIBERATE"> {}

export abstract class ReflectNode
  extends BaseNode<"REASONING.REFLECT"> {}

export abstract class SampleNode
  extends BaseNode<"REASONING.SAMPLE"> {}

export abstract class ContextLoadNode
  extends BaseNode<"CONTEXT.LOAD"> {}

export abstract class ContextSelectNode
  extends BaseNode<"CONTEXT.SELECT"> {}

export abstract class ContextUpdateNode
  extends BaseNode<"CONTEXT.UPDATE"> {}

export abstract class ContextCompressNode
  extends BaseNode<"CONTEXT.COMPRESS"> {}

export abstract class ContextResetNode
  extends BaseNode<"CONTEXT.RESET"> {}

export abstract class MemoryRetrieveNode
  extends BaseNode<"MEMORY.RETRIEVE"> {}

export abstract class MemoryWriteNode
  extends BaseNode<"MEMORY.WRITE"> {}

export abstract class MemoryUpdateNode
  extends BaseNode<"MEMORY.UPDATE"> {}

export abstract class MemoryConsolidateNode
  extends BaseNode<"MEMORY.CONSOLIDATE"> {}

export abstract class MemoryEvictNode
  extends BaseNode<"MEMORY.EVICT"> {}

export abstract class InteractionActNode
  extends BaseNode<"INTERACTION.ACT"> {}

export abstract class InteractionObserveNode
  extends BaseNode<"INTERACTION.OBSERVE"> {}

export abstract class InteractionCommunicateNode
  extends BaseNode<"INTERACTION.COMMUNICATE"> {}

export abstract class InteractionOutputNode
  extends BaseNode<"INTERACTION.OUTPUT"> {}

export type L1NodeType =
  | "REASONING"
  | "CONTEXT"
  | "MEMORY"
  | "INTERACTION";

export type ReasoningNodeType = Extract<
  L2NodeType,
  `REASONING.${string}`
>;

export type ContextNodeType = Extract<
  L2NodeType,
  `CONTEXT.${string}`
>;

export type MemoryNodeType = Extract<
  L2NodeType,
  `MEMORY.${string}`
>;

export type InteractionNodeType = Extract<
  L2NodeType,
  `INTERACTION.${string}`
>;

export interface NodeRequest<TNode extends L2NodeType> {
  node: TNode;
  input: InputOf<TNode>;
}

export interface NodeResponse<TNode extends L2NodeType> {
  node: TNode;
  output: OutputOf<TNode>;
}

export abstract class BaseL1Node<
  TNode extends L2NodeType,
> {
  abstract execute<TSelected extends TNode>(
    request: NodeRequest<TSelected>,
  ): Promise<NodeResponse<TSelected>>;
}

export abstract class ReasoningNode
  extends BaseL1Node<ReasoningNodeType> {}

export abstract class ContextNode
  extends BaseL1Node<ContextNodeType> {}

export abstract class MemoryNode
  extends BaseL1Node<MemoryNodeType> {}

export abstract class InteractionNode
  extends BaseL1Node<InteractionNodeType> {}
