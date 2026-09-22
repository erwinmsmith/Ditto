import type { NodeType } from "../../contracts/index.js";
import type { WorkerType } from "../../worker/node.js";
import type { Payload } from "../artifact.js";

export interface WorkerAddress {
  readonly workerId: string;
  readonly workerType: WorkerType;
  readonly hostId: string;
  readonly processId: string;
}

export interface ExecutionScope {
  readonly graphId: string;
  readonly runId: string;
  readonly nodeId: string;
}

export interface InvokeOptions {
  readonly workerId?: string;
  readonly signal?: AbortSignal;
}

export interface InvocationEnvelope {
  readonly id: string;
  readonly source?: WorkerAddress;
  readonly target: WorkerAddress;
  readonly node: NodeType;
  readonly payload: Payload;
  readonly execution?: ExecutionScope;
}

export interface InvocationResult {
  readonly invocationId: string;
  readonly payload: Payload;
}

/** Adapter owns IPC/RPC encoding, network errors and authentication. */
export interface InvokeTransport {
  readonly id: string;
  invoke(envelope: InvocationEnvelope, options?: { signal?: AbortSignal }): Promise<InvocationResult>;
}

export interface RemoteWorker {
  readonly address: WorkerAddress;
  readonly capabilities: readonly NodeType[];
  readonly transportId: string;
  /** Caller-side concurrency limit; the receiver enforces its own limit too. */
  readonly concurrency?: number;
}
