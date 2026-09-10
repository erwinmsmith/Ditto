import type { InputOf, OutputOf } from "../contracts/index.js";
import type { ArtifactStore } from "../runtime/artifact.js";
import type { RuntimeEvent } from "../runtime/communication/events.js";
import type { ExecutionGraph } from "../runtime/graph.js";
import type { RuntimeServices } from "../runtime/services.js";
import type { ExecutionScope, WorkerAddress } from "../runtime/communication/transport.js";

import type { NodeType } from "./node.js";

export interface RuntimeClient {
  invoke<N extends NodeType>(node: N, input: InputOf<NoInfer<N>>): Promise<OutputOf<N>>;
  emit<T>(event: RuntimeEvent<T>): Promise<void>;
}

/** Execution services are a separate argument; never part of a Node input. */
export interface WorkerContext<R = undefined, C = undefined> extends RuntimeClient {
  readonly resources: R;
  readonly config: C;
  readonly artifacts: ArtifactStore | undefined;
  readonly services: RuntimeServices;
  readonly worker: WorkerAddress;
  readonly execution: ExecutionScope | undefined;
  /** Execute an internal graph entirely on this Worker replica. */
  run<I, O extends object>(plan: ExecutionGraph<I, O>, input: NoInfer<I>): Promise<O>;
}
