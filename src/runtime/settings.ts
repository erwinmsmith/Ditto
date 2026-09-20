import type { MemoryDefaults } from "../worker/memory/types.js";
import type { GenerationConfig } from "../worker/infer/types.js";
import type { DeliberationMode } from "../worker/infer/reasoning/deliberate/types.js";
import type { TrajectoryInput } from "../worker/infer/reasoning/trajectory/types.js";
import { common } from "../worker/infer/validation.js";

export interface InferSettings {
  readonly generation?: GenerationConfig;
  readonly deliberate?: { readonly mode?: DeliberationMode; readonly selectCount?: number; readonly generation?: GenerationConfig };
  readonly constraints?: TrajectoryInput["constraints"];
  readonly strategies?: {
    readonly cot?: { readonly rounds?: number };
    readonly "long-cot"?: { readonly rounds?: number };
    readonly tot?: { readonly breadth?: number; readonly depth?: number; readonly beamWidth?: number };
    readonly got?: { readonly breadth?: number; readonly depth?: number };
    readonly "self-consistency"?: { readonly candidates?: number };
  };
}
/** Non-secret application defaults. Credentials and deployment bindings belong in env. */
export interface RuntimeSettings {
  readonly runtime?: {
    readonly timeoutMs?: number;
    readonly maxTurns?: number;
    readonly react?: { readonly maxActionCalls?: number; readonly maxTotalTokens?: number };
  };
  readonly workers?: { readonly infer?: InferSettings; readonly memory?: MemoryDefaults };
  readonly shared?: {
    readonly providers?: Readonly<Record<string, {
      readonly maxTokensField?: "max_tokens" | "max_completion_tokens";
      readonly options?: Readonly<Record<string, unknown>>;
    }>>;
  };
}

function record(value: unknown, path: string, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  for (const key of Object.keys(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key) || (keys && !keys.includes(key))) throw new Error(`Unknown setting: ${path}.${key}`);
  }
  return value as Record<string, unknown>;
}
function integers(value: unknown, path: string, bounds: Record<string, readonly [number, number]>): void {
  const entry = record(value, path, Object.keys(bounds));
  for (const [key, v] of Object.entries(entry)) {
    const [min, max] = bounds[key]!;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new Error(`${path}.${key} must be an integer in ${min}..${max}`);
  }
}
function generation(value: unknown, path: string): void {
  record(value, path, ["temperature", "topP", "topK", "maxTokens", "stop", "seed"]);
  common({ model: { model: "config" }, generation: value });
}
const positive = [1, Number.MAX_SAFE_INTEGER] as const;
const timeout = [1, 2 ** 31 - 1] as const;
const branch = [1, 16] as const;

/** Snapshot once at startup; callers cannot mutate nested defaults during concurrent requests. */
export function validateRuntimeSettings(value: unknown): RuntimeSettings {
  const v = record(value, "config", ["runtime", "workers", "shared"]);
  if (v.runtime !== undefined) {
    const { react, ...runtime } = record(v.runtime, "runtime", ["timeoutMs", "maxTurns", "react"]);
    integers(runtime, "runtime", { timeoutMs: timeout, maxTurns: positive });
    if (react !== undefined) integers(react, "runtime.react", { maxActionCalls: [0, Number.MAX_SAFE_INTEGER], maxTotalTokens: positive });
  }
  const workers = v.workers === undefined ? {} : record(v.workers, "workers", ["infer", "memory"]);
  if (workers.memory !== undefined) integers(workers.memory, "workers.memory", { queryLimit: [1, 10000], searchLimit: [1, 10000] });
  if (workers.infer !== undefined) {
    const infer = record(workers.infer, "workers.infer", ["generation", "constraints", "strategies", "deliberate"]);
    if (infer.generation !== undefined) generation(infer.generation, "workers.infer.generation");
    if (infer.deliberate !== undefined) {
      const { mode, generation: gen, ...selection } = record(infer.deliberate, "workers.infer.deliberate", ["mode", "selectCount", "generation"]);
      if (mode !== undefined && (typeof mode !== "string" || !["select", "merge", "consensus", "debate"].includes(mode))) throw new Error("Invalid workers.infer.deliberate.mode");
      integers(selection, "workers.infer.deliberate", { selectCount: positive });
      if (gen !== undefined) generation(gen, "workers.infer.deliberate.generation");
    }
    if (infer.constraints !== undefined) integers(infer.constraints, "workers.infer.constraints", { maxSteps: positive, maxTotalTokens: positive, timeoutMs: timeout });
    if (infer.strategies !== undefined) {
      const strategies = record(infer.strategies, "workers.infer.strategies", ["cot", "long-cot", "tot", "got", "self-consistency"]);
      for (const [name, options] of Object.entries(strategies)) {
        const bounds: Record<string, readonly [number, number]> = name === "cot" || name === "long-cot" ? { rounds: [1, 64] }
          : name === "self-consistency" ? { candidates: branch }
          : name === "tot" ? { breadth: branch, depth: branch, beamWidth: branch } : { breadth: branch, depth: branch };
        integers(options, `workers.infer.strategies.${name}`, bounds);
      }
    }
  }
  const shared = v.shared === undefined ? {} : record(v.shared, "shared", ["providers"]);
  if (shared.providers !== undefined) {
    for (const [name, entry] of Object.entries(record(shared.providers, "shared.providers"))) {
      if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid provider name: ${name}`);
      const provider = record(entry, `shared.providers.${name}`, ["maxTokensField", "options"]);
      if (provider.maxTokensField !== undefined && provider.maxTokensField !== "max_tokens" && provider.maxTokensField !== "max_completion_tokens") throw new Error(`Invalid max tokens field: ${name}`);
      if (provider.options !== undefined) record(provider.options, `shared.providers.${name}.options`);
    }
  }
  const snapshot = structuredClone(v);
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object" && !Object.isFrozen(item)) { Object.freeze(item); Object.values(item).forEach(freeze); }
  };
  freeze(snapshot);
  return snapshot as RuntimeSettings;
}
