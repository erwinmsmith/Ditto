import type { Message, ReasoningStep } from "../../../types.js";
import type { SampleOutput } from "../../sample/types.js";
import type { DeliberateInput, DeliberateOutput } from "../../deliberate/types.js";
import type { TrajectoryInput } from "../types.js";
export interface StepTrace { parentIds?: string[]; summary?: string }
export interface StrategyContext {
  readonly input: TrajectoryInput;
  readonly messages: Message[];
  readonly signal: AbortSignal;
  sample(messages: Message[], trace?: StepTrace): Promise<SampleOutput & { stepId: string }>;
  deliberate(candidates: DeliberateInput["candidates"], mode: DeliberateInput["mode"], options?: StepTrace & { selectCount?: number }): Promise<DeliberateOutput & { stepId: string }>;
  step(step: Omit<ReasoningStep, "id" | "index">): ReasoningStep;
}
export type TrajectoryStrategy = (context: StrategyContext) => Promise<Message>;
