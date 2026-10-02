import type { SampleInput, SampleOutput } from "../reasoning/sample/types.js";
export type ModelStreamEvent =
  | { type: "text_delta" | "reasoning_delta"; delta: string }
  | { type: "action_delta"; index: number; id?: string; name?: string; delta: string }
  | { type: "result"; output: SampleOutput };
/** Shared by Runtime services, INFER, custom integrations, and every HTTP protocol. */
export interface ModelProvider {
  invoke(input: SampleInput, options: { signal: AbortSignal }): Promise<SampleOutput>;
  stream?(input: SampleInput, options: { signal: AbortSignal }): AsyncIterable<ModelStreamEvent>;
}
export interface ProviderResolver { get(name?: string): ModelProvider }
/** Internal wire protocol; transport, credentials and SSE framing stay in http.ts. */
export interface ProviderProtocol {
  path(model: string, streaming: boolean): string;
  headers(apiKey?: string): Record<string, string>;
  body(input: SampleInput, streaming: boolean): unknown;
  parse(raw: unknown): SampleOutput;
  stream(events: AsyncIterable<string>): AsyncIterable<ModelStreamEvent>;
}
