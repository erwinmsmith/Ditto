import type {
  InferInput, InferOutput, DeliberateInput, DeliberateOutput, ReflectInput, ReflectOutput, SampleInput, SampleOutput
} from "../worker/reasoning/contracts.js";
import type {
  ContextLoadInput, ContextLoadOutput, ContextSelectInput, ContextSelectOutput, ContextUpdateInput, ContextUpdateOutput, ContextCompressInput, ContextCompressOutput, ContextResetInput, ContextResetOutput
} from "../worker/context/contracts.js";
import type {
  MemoryRetrieveInput, MemoryRetrieveOutput, MemoryWriteInput, MemoryWriteOutput, MemoryUpdateInput, MemoryUpdateOutput, MemoryConsolidateInput, MemoryConsolidateOutput, MemoryEvictInput, MemoryEvictOutput
} from "../worker/memory/contracts.js";
import type {
  InteractionActInput, InteractionActOutput, InteractionObserveInput, InteractionObserveOutput, InteractionCommunicateInput, InteractionCommunicateOutput, InteractionOutputInput, InteractionOutputOutput
} from "../worker/interaction/contracts.js";

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
