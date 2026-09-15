import type { NodeType } from "../contracts/index.js";
import type { WorkerExecutor } from "../worker/define-worker.js";
import type { WorkerAddress } from "./communication/transport.js";

export interface WorkerEntry {
  readonly address: WorkerAddress;
  readonly capabilities: readonly NodeType[];
  readonly nodeTypes?: readonly NodeType[];
  readonly executor?: WorkerExecutor;
  readonly transportId?: string;
  available: boolean;
  readonly concurrency: number;
  active: number;
  readonly pending: Set<Promise<unknown>>;
}

export class NoWorkerAvailableError extends Error {
  constructor(readonly node: NodeType) {
    super(`No available Worker implements ${node}`);
    this.name = "NoWorkerAvailableError";
  }
}

/** Filters actual capability/availability, then direct > same host > remote. */
export class WorkerRouter {
  readonly #next = new Map<NodeType, number>();

  select(node: NodeType, entries: Iterable<WorkerEntry>, hostId: string): WorkerEntry {
    let priority = Infinity;
    const pool: WorkerEntry[] = [];
    for (const entry of entries) {
      if (!entry.available || entry.active >= entry.concurrency || !entry.capabilities.includes(node)) continue;
      const rank = entry.executor ? 0 : entry.address.hostId === hostId ? 1 : 2;
      if (rank < priority) { priority = rank; pool.length = 0; }
      if (rank === priority) pool.push(entry);
    }
    if (!pool.length) throw new NoWorkerAvailableError(node);
    const index = (this.#next.get(node) ?? 0) % pool.length;
    this.#next.set(node, (index + 1) % pool.length);
    return pool[index]!;
  }
}
