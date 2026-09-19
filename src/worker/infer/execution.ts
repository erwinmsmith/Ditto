import type { InferSettings } from "../../runtime/settings.js";
import type { ProviderResolver } from "./providers/types.js";
import type { InferCacheProvider } from "./cache/provider.js";
import type { SampleInput, SampleOutput } from "./reasoning/sample/types.js";
import type { ReasoningStep } from "./types.js";
import type { TrajectoryStrategy } from "./reasoning/trajectory/strategies/index.js";
export interface InferExecution {
  defaults?: InferSettings;
  strategies: Readonly<Record<string, TrajectoryStrategy>>;
  signal: AbortSignal;
  providers: ProviderResolver;
  defaultProvider?: string;
  cache: InferCacheProvider;
  streaming: boolean;
  emitDelta(delta: string): void;
  emitStep(step: ReasoningStep): void;
  sample(input: SampleInput): Promise<SampleOutput>;
}
