import type { Message, ModelConfig, GenerationConfig, ContextItem, MemoryItem, ReasoningStep, Usage } from "../../types.js";
export interface TrajectoryInput {
  messages: Message[];
  objective?: string;
  context?: ContextItem[];
  memory?: MemoryItem[];
  strategy: { name: string; options?: Record<string, unknown> };
  model: ModelConfig;
  generation?: GenerationConfig;
  constraints?: { maxSteps?: number; maxTotalTokens?: number; timeoutMs?: number };
  metadata?: Record<string, unknown>;
}
export interface TrajectoryOutput {
  result: Message;
  steps: ReasoningStep[];
  status: "completed" | "partial" | "failed";
  stopReason: "completed" | "max_steps" | "max_tokens" | "timeout" | "cancelled" | "error";
  usage?: Usage;
}
