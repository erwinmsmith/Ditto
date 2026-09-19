import type { Message, ModelConfig, GenerationConfig, ContextItem, ReasoningStep, Usage } from "../../types.js";
export type DeliberationMode = "select" | "merge" | "consensus" | "debate";
export interface DeliberateInput {
  messages?: Message[];
  /** Number retained by select; inherits configuration, otherwise 1. */
  selectCount?: number;
  objective?: string;
  candidates: Array<{ id: string; result: Message; trajectory?: ReasoningStep[]; score?: number }>;
  /** Inherits deliberate defaults; falls back to select. */
  mode?: DeliberationMode;
  context?: ContextItem[];
  model: ModelConfig;
  generation?: GenerationConfig;
  metadata?: Record<string, unknown>;
}
export interface DeliberateOutput {
  result: Message;
  selectedCandidateIds?: string[];
  assessments?: Array<{ candidateId: string; score?: number; accepted?: boolean; summary?: string }>;
  decisionSummary?: string;
  usage?: Usage;
}
