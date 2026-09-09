import { randomUUID } from "node:crypto";
import type { InputOf, OutputOf } from "../contracts/index.js";
import type { NodeType, RuntimeClient, WorkerContext } from "../node/index.js";
import { workerTypeOf } from "../node/index.js";
import type { WorkerDefinition } from "../worker/index.js";
import { PayloadCodec, type ArtifactStore } from "./artifact.js";
import { LocalEventFabric, type EventFabric, type EventHandler, type RuntimeEvent } from "./events.js";
import { graph, type ExecutionGraph } from "./graph.js";
import { WorkerRouter, type WorkerEntry } from "./router.js";
import { runGraph } from "./scheduler.js";
import type {
  ExecutionScope, InvocationEnvelope, InvocationResult, InvokeTransport, RemoteWorker, WorkerAddress,
} from "./transport.js";

export interface DittoOptions {
  readonly workers?: readonly WorkerDefinition[];
  readonly hostId?: string;
  readonly processId?: string;
  readonly transports?: readonly InvokeTransport[];
  readonly events?: EventFabric;
  readonly artifacts?: ArtifactStore;
  readonly inlineLimitBytes?: number;
}

export interface WorkerHandle {
  readonly address: WorkerAddress;
  setAvailable(available: boolean): void;
  unregister(): boolean;
}

export class DittoRuntime implements RuntimeClient {
  readonly hostId: string;
  readonly processId: string;
  readonly #workers = new Map<string, WorkerEntry>();
  readonly #transports = new Map<string, InvokeTransport>();
  readonly #router = new WorkerRouter();
  readonly #codec: PayloadCodec;
  readonly #events: EventFabric;

  constructor(options: DittoOptions = {}) {
    this.hostId = options.hostId ?? "local";
    this.processId = options.processId ?? randomUUID();
    this.#codec = new PayloadCodec(options.artifacts, options.inlineLimitBytes);
    this.#events = options.events ?? new LocalEventFabric();
    for (const transport of options.transports ?? []) {
      if (!transport.id || this.#transports.has(transport.id)) {
        throw new Error(`Duplicate or empty Transport ID: ${transport.id}`);
      }
      this.#transports.set(transport.id, transport);
    }
    for (const worker of options.workers ?? []) this.register(worker);
  }

  register(worker: WorkerDefinition, workerId: string = randomUUID()): WorkerHandle {
    this.#checkId(workerId);
    const address = Object.freeze({
      workerId, workerType: worker.type, hostId: this.hostId, processId: this.processId,
    });
    const entry: WorkerEntry = {
      address, capabilities: this.#capabilities(address, worker.capabilities),
      executor: worker.instantiate(), available: true,
    };
    return this.#add(entry);
  }

  registerRemote(worker: RemoteWorker): WorkerHandle {
    this.#checkId(worker.address.workerId);
    if (!this.#transports.has(worker.transportId)) {
      throw new Error(`Transport is not installed: ${worker.transportId}`);
    }
    if (worker.address.hostId === this.hostId && worker.address.processId === this.processId) {
      throw new Error("Use register for Workers in the current process");
    }
    return this.#add({
      address: Object.freeze({ ...worker.address }),
      capabilities: this.#capabilities(worker.address, worker.capabilities),
      transportId: worker.transportId, available: true,
    });
  }

  workers(): readonly { address: WorkerAddress; capabilities: readonly NodeType[]; available: boolean }[] {
    return [...this.#workers.values()].map(({ address, capabilities, available }) => ({
      address, capabilities, available,
    }));
  }

  async invoke<N extends NodeType>(node: N, input: InputOf<NoInfer<N>>): Promise<OutputOf<N>> {
    return this.#invoke(node, input) as Promise<OutputOf<N>>;
  }

  emit<T>(event: RuntimeEvent<T>): Promise<void> {
    return this.#events.emit(event);
  }

  subscribe(type: string, handler: EventHandler): () => boolean {
    return this.#events.subscribe(type, handler);
  }

  /** Wait for accepted events, returning consumer failures separately from emit. */
  drainEvents(): ReturnType<EventFabric["drain"]> {
    return this.#events.drain();
  }

  graph<I>(id = "agent"): ExecutionGraph<I> {
    return graph<I>(id);
  }

  run<I, O extends object>(plan: ExecutionGraph<I, O>, input: NoInfer<I>): Promise<O> {
    return runGraph(plan, input, (node, value, scope) => this.#invoke(node, value, undefined, scope));
  }

  /** Adapter-facing receiver. This is not an unauthenticated network server. */
  async receive(envelope: InvocationEnvelope): Promise<InvocationResult> {
    const entry = this.#workers.get(envelope.target.workerId);
    if (!entry?.executor || !entry.available
      || entry.address.hostId !== envelope.target.hostId
      || entry.address.processId !== envelope.target.processId
      || entry.address.workerType !== envelope.target.workerType
      || !entry.capabilities.includes(envelope.node)) {
      throw new Error(`Invocation target unavailable or mismatched: ${envelope.target.workerId}`);
    }
    const input = await this.#codec.decode(envelope.payload);
    const output = await entry.executor.execute(envelope.node, input, this.#context(entry.address, envelope.execution));
    return { invocationId: envelope.id, payload: await this.#codec.encode(output) };
  }

  async #invoke(node: NodeType, input: unknown, source?: WorkerAddress, execution?: ExecutionScope): Promise<unknown> {
    const entry = this.#router.select(node, this.#workers.values(), this.hostId);
    if (entry.executor) {
      return entry.executor.execute(node, input, this.#context(entry.address, execution));
    }
    const transport = this.#transports.get(entry.transportId!)!;
    const id = randomUUID();
    const response = await transport.invoke({
      id, node, target: entry.address, payload: await this.#codec.encode(input),
      ...(source ? { source } : {}), ...(execution ? { execution } : {}),
    });
    if (response.invocationId !== id) throw new Error("Transport returned a mismatched invocation ID");
    return this.#codec.decode(response.payload);
  }

  #context(source: WorkerAddress, execution?: ExecutionScope): WorkerContext {
    return {
      resources: undefined, config: undefined, artifacts: this.#codec.artifacts,
      invoke: <N extends NodeType>(node: N, input: InputOf<NoInfer<N>>) =>
        this.#invoke(node, input, source, execution) as Promise<OutputOf<N>>,
      emit: <T>(event: RuntimeEvent<T>) => this.emit(event),
    };
  }

  #checkId(id: string): void {
    if (!id || this.#workers.has(id)) throw new Error(`Duplicate or empty Worker ID: ${id}`);
  }

  #capabilities(address: WorkerAddress, nodes: readonly NodeType[]): readonly NodeType[] {
    if (!nodes.length || nodes.some((node) => workerTypeOf(node) !== address.workerType)) {
      throw new Error(`Invalid capabilities for Worker ${address.workerId}`);
    }
    return Object.freeze([...new Set(nodes)]);
  }

  #add(entry: WorkerEntry): WorkerHandle {
    this.#workers.set(entry.address.workerId, entry);
    return Object.freeze({
      address: entry.address,
      setAvailable: (available: boolean) => { entry.available = available; },
      unregister: () => {
        if (this.#workers.get(entry.address.workerId) !== entry) return false;
        return this.#workers.delete(entry.address.workerId);
      },
    });
  }
}

export function createDitto(options: DittoOptions = {}): DittoRuntime {
  return new DittoRuntime(options);
}
