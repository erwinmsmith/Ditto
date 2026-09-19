import type { NodeResult } from "./types.js";
import type { SampleInput, SampleOutput } from "./reasoning/sample/types.js";
import type { TrajectoryInput, TrajectoryOutput } from "./reasoning/trajectory/types.js";
import type { ReflectInput, ReflectOutput } from "./reasoning/reflect/types.js";
import type { DeliberateInput, DeliberateOutput } from "./reasoning/deliberate/types.js";
import type { CacheLookupInput, CacheLookupOutput } from "./cache/lookup/types.js";
import type { CacheWriteInput, CacheWriteOutput } from "./cache/write/types.js";
import type { CacheInvalidateInput, CacheInvalidateOutput } from "./cache/invalidate/types.js";
export interface InferContractMap {
  "INFER.REASONING.SAMPLE": { input: SampleInput; output: SampleOutput };
  "INFER.REASONING.TRAJECTORY": { input: TrajectoryInput; output: TrajectoryOutput };
  "INFER.REASONING.REFLECT": { input: ReflectInput; output: ReflectOutput };
  "INFER.REASONING.DELIBERATE": { input: DeliberateInput; output: DeliberateOutput };
  "INFER.CACHE.LOOKUP": { input: CacheLookupInput; output: CacheLookupOutput };
  "INFER.CACHE.WRITE": { input: CacheWriteInput; output: CacheWriteOutput };
  "INFER.CACHE.INVALIDATE": { input: CacheInvalidateInput; output: CacheInvalidateOutput };
}
export type InferNode = keyof InferContractMap;
export type InferInput<N extends InferNode> = InferContractMap[N]["input"];
export type InferOutput<N extends InferNode> = InferContractMap[N]["output"];
type RuntimeContracts = { [N in InferNode]: { input: InferInput<N>; output: NodeResult<InferOutput<N>> } };
declare module "../../contracts/node-contract-map.js" {
  interface NodeContractMap extends RuntimeContracts {}
}
