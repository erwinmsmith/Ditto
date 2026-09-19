import type { Message, ModelConfig, GenerationConfig, ContextItem, ReasoningStep, Usage } from "../../types.js";
export interface DeliberateInput {
  messages?: Message[];
  /** Number of ranked candidates retained by select; default 1. */
  selectCount?: number;
  objective?: string;
  candidates: Array<{ id: string; result: Message; trajectory?: ReasoningStep[]; score?: number }>;
  mode: "select" | "merge" | "consensus" | "debate";
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
