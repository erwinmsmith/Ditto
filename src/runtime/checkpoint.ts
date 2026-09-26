import { createHash } from "node:crypto";

/** Portable checkpoints contain explicit JSON state, never closures or live resources. */
export interface StateCheckpoint<T> {
  readonly format: 1;
  readonly scope: string;
  readonly version: string;
  readonly state: T;
  readonly digest: string;
}

export function stateDigest(value: unknown): string {
  const visiting = new Set<object>();
  const encode = (v: unknown): string => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (!v || typeof v !== "object" || visiting.has(v)) throw new Error("Checkpoint state must be acyclic JSON");
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
      throw new Error("Checkpoint state cannot contain live resources or class instances");
    visiting.add(v);
    const result = Array.isArray(v) ? `[${Array.from(v, encode).join(",")}]`
      : `{${Object.keys(v).sort().filter(k => (v as Record<string, unknown>)[k] !== undefined)
        .map(k => `${JSON.stringify(k)}:${encode((v as Record<string, unknown>)[k])}`).join(",")}}`;
    visiting.delete(v);
    return result;
  };
  return createHash("sha256").update(encode(value)).digest("hex");
}

export function checkpointState<T>(scope: string, version: string, state: T): StateCheckpoint<T> {
  if (!scope.trim() || !version.trim()) throw new Error("Checkpoint scope and version are required");
  const digest = stateDigest({ scope, version, state });
  return { format: 1, scope, version, state: JSON.parse(JSON.stringify(state)) as T, digest };
}

export function restoreState<T>(checkpoint: StateCheckpoint<T>, scope: string, version: string): T {
  if (checkpoint.format !== 1 || checkpoint.scope !== scope || checkpoint.version !== version
    || checkpoint.digest !== stateDigest({ scope, version, state: checkpoint.state }))
    throw new Error("Checkpoint scope, version or integrity mismatch");
  return JSON.parse(JSON.stringify(checkpoint.state)) as T;
}

export interface GraphCheckpointState {
  readonly graphHash: string;
  readonly inputHash: string;
  readonly outputs: Readonly<Record<string, unknown>>;
  /** Failed in-flight operations may have effects; automatic replay is forbidden. */
  readonly uncertain: readonly string[];
}
export type GraphCheckpoint = StateCheckpoint<GraphCheckpointState>;
export interface GraphCheckpointOptions {
  /** Include application configuration and resource snapshot versions in this value. */
  readonly version: string;
  readonly resume?: GraphCheckpoint;
  /** Awaited at a quiescent boundary, before more Nodes are admitted. */
  readonly save: (checkpoint: GraphCheckpoint) => void | Promise<void>;
}

export interface LoopCheckpointState {
  readonly iteration: number;
  readonly state: unknown;
  readonly completed: boolean;
}
export interface LoopCheckpointOptions {
  readonly id: string;
  readonly version: string;
  readonly resume?: StateCheckpoint<LoopCheckpointState>;
  readonly save: (checkpoint: StateCheckpoint<LoopCheckpointState>) => void | Promise<void>;
}
