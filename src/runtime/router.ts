import type { NodeType } from "../node/index.js";
import { workerTypeOf } from "../node/index.js";
import type { WorkerExecutor } from "../worker/index.js";
import type { WorkerAddress } from "./transport.js";

export interface WorkerEntry {
  readonly address: WorkerAddress;
  readonly capabilities: readonly NodeType[];
  readonly executor?: WorkerExecutor;
  readonly transportId?: string;
  available: boolean;
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
    const candidates = [...entries].filter((entry) => entry.available
      && entry.address.workerType === workerTypeOf(node)
      && entry.capabilities.includes(node));
    if (!candidates.length) throw new NoWorkerAvailableError(node);
    const rank = (entry: WorkerEntry): number => entry.executor ? 0
      : entry.address.hostId === hostId ? 1 : 2;
    const priority = Math.min(...candidates.map(rank));
    const pool = candidates.filter((entry) => rank(entry) === priority);
    const index = (this.#next.get(node) ?? 0) % pool.length;
    this.#next.set(node, (index + 1) % pool.length);
    return pool[index]!;
  }
}
