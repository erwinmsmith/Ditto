import type {
  Context, ModelInput, ModelOutput, ReasoningBudget, ReasoningTraceEvent,
} from "../../../contracts/common.js";

export type {
  ModelInput, ModelOutput, ReasoningBudget, ReasoningTraceEvent,
} from "../../../contracts/common.js";

export interface TrajectoryInput {
  input: ModelInput;
  strategy: string;
  budget?: ReasoningBudget;
}
export interface TrajectoryOutput {
  result: ModelOutput;
  trace: readonly ReasoningTraceEvent[];
}
export interface ReflectInput {
  result: ModelOutput;
  context?: Context;
  criteria?: readonly import("../../../contracts/common.js").Message[];
}
export type ReflectOutput = ModelOutput;
export interface DeliberateInput {
  input: ModelInput;
  budget: ReasoningBudget;
  alternatives?: readonly ModelOutput[];
}
export type DeliberateOutput = ModelOutput;
export interface SampleInput { input: ModelInput; count: number; }
export type SampleOutput = readonly ModelOutput[];

declare module "../../../contracts/node-contract-map.js" {
  interface NodeContractMap {
    "INFER.REASONING.TRAJECTORY": NodeContract<TrajectoryInput, TrajectoryOutput>;
    "INFER.REASONING.REFLECT": NodeContract<ReflectInput, ReflectOutput>;
    "INFER.REASONING.DELIBERATE": NodeContract<DeliberateInput, DeliberateOutput>;
    "INFER.REASONING.SAMPLE": NodeContract<SampleInput, SampleOutput>;
  }
}
