import { common, messagesAndActions, object, message, list, text, check, usage, modelOutput } from "../../validation.js";
import type { SampleInput, SampleOutput } from "./types.js";
export function validateSample(input: unknown): asserts input is SampleInput { messagesAndActions(common(input)); }
export function validateSampleOutput(input: unknown): asserts input is SampleOutput {
  modelOutput(() => {
    const v = object(input); message(v.message); check(v.message.role === "assistant", "SAMPLE must return an assistant message");
    check(["stop", "length", "action_request", "cancelled", "error"].includes(String(v.finishReason)), "Invalid finishReason");
    if (v.usage !== undefined) usage(v.usage);
    const ids = new Set<string>();
    if (v.actionRequests !== undefined) {
      list(v.actionRequests, "actionRequests");
      for (const raw of v.actionRequests) { const a = object(raw); text(a.id, "action.id"); text(a.name, "action.name"); object(a.arguments); check(!ids.has(a.id), "Duplicate action ID"); ids.add(a.id); }
    }
    check((v.finishReason === "action_request") === (ids.size > 0), "action_request finishReason and actionRequests must agree");
  });
}
