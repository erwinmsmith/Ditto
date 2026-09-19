import type { Message, ModelConfig, GenerationConfig, ActionDescriptor, ActionRequest, Usage } from "../../types.js";
export interface SampleInput {
  messages: Message[];
  model: ModelConfig;
  generation?: GenerationConfig;
  actions?: ActionDescriptor[];
  metadata?: Record<string, unknown>;
}
export interface SampleOutput {
  message: Message;
  actionRequests?: ActionRequest[];
  finishReason: "stop" | "length" | "action_request" | "cancelled" | "error";
  usage?: Usage;
}
