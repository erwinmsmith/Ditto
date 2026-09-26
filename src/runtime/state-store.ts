import { checkpointState, restoreState, type StateCheckpoint } from "./checkpoint.js";

export interface StoreState { readonly revision: number; readonly values: Readonly<Record<string, unknown>> }
export type StoreSnapshot = StateCheckpoint<StoreState>;

/** One atomic authority for explicit Context/Memory/artifact/tool-session state.
 * External effects must use a separate transactional adapter; they are not rolled back here.
 * Values cross the API as JSON copies; forks share immutable base values until writes occur.
 */
export class BranchStore {
  #values = new Map<string, unknown>();
  #revision = 0;
  constructor(readonly id: string, snapshot?: StoreSnapshot) {
    if (!id.trim()) throw new Error("State store ID is required");
    if (snapshot) {
      const state = restoreState(snapshot, `store:${id}`, "1");
      if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error("Invalid store revision");
      this.#revision = state.revision;
      this.#values = new Map(Object.entries(state.values));
    }
  }
  get revision(): number { return this.#revision; }
  snapshot(): StoreSnapshot {
    return checkpointState(`store:${this.id}`, "1", { revision: this.#revision, values: Object.fromEntries(this.#values) });
  }
  fork(): StateBranch {
    const revision = this.#revision;
    return new StateBranch(new Map(this.#values), revision, writes => {
      if (revision !== this.#revision) throw new Error("State branch commit conflict");
      for (const [key, entry] of writes) {
        if (entry.deleted) this.#values.delete(key); else this.#values.set(key, entry.value);
      }
      this.#revision++;
    });
  }
}
type Write = { readonly deleted: true } | { readonly deleted: false; readonly value: unknown };
export class StateBranch {
  #closed = false;
  readonly #writes = new Map<string, Write>();
  constructor(private readonly base: ReadonlyMap<string, unknown>, readonly revision: number,
    private readonly apply: (writes: ReadonlyMap<string, Write>) => void) {}
  #open(): void { if (this.#closed) throw new Error("State branch is closed"); }
  get<T>(key: string): T | undefined {
    this.#open();
    const entry = this.#writes.get(key);
    const value = entry ? entry.deleted ? undefined : entry.value : this.base.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }
  set(key: string, value: unknown): void {
    this.#open();
    if (!key) throw new Error("State key is required");
    this.#writes.set(key, { deleted: false, value: checkpointState("value", "1", value).state });
  }
  delete(key: string): void { this.#open(); this.#writes.set(key, { deleted: true }); }
  commit(): void { this.#open(); this.apply(this.#writes); this.#closed = true; this.#writes.clear(); }
  discard(): void { this.#open(); this.#writes.clear(); this.#closed = true; }
}
