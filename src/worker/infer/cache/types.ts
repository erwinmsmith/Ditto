export interface InferCacheKey {
  namespace?: string;
  scope: "sample" | "trajectory" | "reflection" | "deliberation" | string;
  key: string;
}
