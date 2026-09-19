import type { Message, ModelConfig, GenerationConfig, ContextItem, MemoryItem, ReasoningStep, Usage } from "../../types.js";
export type ReflectionMode = "critique" | "verify" | "revise";
export interface ReflectInput {
  messages?: Message[];
  target: { result?: Message; trajectory?: ReasoningStep[]; artifact?: unknown };
  mode: ReflectionMode;
  criteria?: Array<{ id: string; description: string; weight?: number }>;
  context?: ContextItem[];
  memory?: MemoryItem[];
  model: ModelConfig;
  generation?: GenerationConfig;
  metadata?: Record<string, unknown>;
}
export interface ReflectOutput {
  assessment: { passed?: boolean; summary: string };
  issues: Array<{ severity: "info" | "warning" | "error"; description: string; suggestedFix?: string }>;
  revisedResult?: Message;
  usage?: Usage;
}
