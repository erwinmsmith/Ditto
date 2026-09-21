import type {
  MemoryGetInput, MemoryGetOutput, MemoryQueryInput, MemoryQueryOutput,
  MemorySearchInput, MemorySearchOutput, MemoryWriteInput, MemoryWriteOutput,
  MemoryUpdateInput, MemoryUpdateOutput, MemoryDeleteInput, MemoryDeleteOutput,
} from "../contracts.js";
/** Deterministic source of truth. Resource lifetime belongs to the application. */
export interface MemoryStore {
  get(input: MemoryGetInput): Promise<MemoryGetOutput>;
  query(input: MemoryQueryInput): Promise<MemoryQueryOutput>;
  write(input: MemoryWriteInput): Promise<MemoryWriteOutput>;
  /** Partial fields; supplied metadata replaces the object. Missing targets must fail. */
  update(input: MemoryUpdateInput): Promise<MemoryUpdateOutput>;
  /** Idempotent; report only IDs actually deleted by this call. */
  delete(input: MemoryDeleteInput): Promise<MemoryDeleteOutput>;
}
export interface MemorySearchProvider { search(input: MemorySearchInput): Promise<MemorySearchOutput>; }
export interface MemoryResources {
  /** The database plugin can also supply native search using the same SDK/client. */
  readonly store: MemoryStore & Partial<MemorySearchProvider>;
  /** Explicit override for a separate index, local pipeline or optional RETRIEVAL Worker. */
  readonly search?: MemorySearchProvider;
}
