import { createHash, randomUUID } from "node:crypto";
import type { ExecutionScope } from "./communication/transport.js";
import type { InputOf, NodeType, OutputOf } from "../contracts/index.js";
import type {
  Context, ContextIngress, ContextSource, JsonObject, Observation,
  MessageContent, Reference, ToolCall,
} from "../contracts/common.js";
import type { RuntimeClient } from "../worker/execution-context.js";
import type { ContextSelection } from "../worker/context/contracts.js";
import type { InteractionMcpInput, InteractionMcpOutput, InteractionToolOutput } from "../worker/interaction/contracts.js";
import { checkpointState, restoreState, stateDigest, type GraphCheckpointOptions } from "./checkpoint.js";

export interface GraphTask {
  readonly id: string;
  readonly node: NodeType;
  readonly dependencies: readonly string[];
  readonly bind: (input: unknown, outputs: Readonly<Record<string, unknown>>) => unknown;
}

/** Immutable logical DAG. No Worker IDs, model configuration or host addresses. */
export class ExecutionGraph<I, O extends object = Record<never, never>> {
  private constructor(readonly id: string, readonly tasks: readonly GraphTask[]) {
    Object.freeze(this);
  }

  static create<I>(id: string): ExecutionGraph<I> {
    if (!id) throw new Error("Graph ID cannot be empty");
    return new ExecutionGraph<I>(id, Object.freeze([]));
  }

  node<const ID extends string, N extends NodeType, const D extends readonly (keyof O & string)[]>(
    id: ID,
    node: N,
    dependencies: D,
    bind: (input: I, outputs: Pick<O, D[number]>) => InputOf<NoInfer<N>>,
  ): ExecutionGraph<I, O & Record<ID, OutputOf<N>>> {
    if (!id || this.tasks.some((task) => task.id === id)) {
      throw new Error(`Duplicate or empty graph Node ID: ${id}`);
    }
    const known = new Set(this.tasks.map((task) => task.id));
    for (const dependency of dependencies) {
      if (!known.has(dependency)) throw new Error(`Unknown graph dependency: ${dependency}`);
    }
    const task: GraphTask = Object.freeze({
      id, node, dependencies: Object.freeze([...new Set(dependencies)]),
      // The builder checks the typed binder. Scheduler passes only declared outputs.
      bind: bind as GraphTask["bind"],
    });
    return new ExecutionGraph(this.id, Object.freeze([...this.tasks, task]));
  }
}

export function graph<I>(id = "agent"): ExecutionGraph<I> {
  return ExecutionGraph.create<I>(id);
}

export interface GraphRunOptions {
  /** Maximum simultaneously running graph nodes. No hidden invocation queue. */
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly checkpoint?: GraphCheckpointOptions;
}

export async function runGraph<I, O extends object>(
  graph: ExecutionGraph<I, O>,
  input: I,
  invoke: (node: NodeType, input: unknown, scope: ExecutionScope) => Promise<unknown>,
  options: GraphRunOptions = {},
): Promise<O> {
  const concurrency = options.concurrency ?? Infinity;
  if (concurrency !== Infinity && (!Number.isSafeInteger(concurrency) || concurrency < 1)) {
    throw new Error("Graph concurrency must be a positive integer");
  }
  options.signal?.throwIfAborted();
  const checkpoint = options.checkpoint;
  const graphHash = checkpoint ? stateDigest(graph.tasks.map(t => [t.id, t.node, t.dependencies, t.bind.toString()])) : "";
  const inputHash = checkpoint ? stateDigest(input) : "";
  const restored = checkpoint?.resume ? restoreState(checkpoint.resume, `graph:${graph.id}`, checkpoint.version) : undefined;
  if (restored && (restored.graphHash !== graphHash || restored.inputHash !== inputHash || restored.uncertain.length))
    throw new Error("Graph checkpoint is incompatible or has uncertain operations");
  const outputs: Record<string, unknown> = Object.assign(Object.create(null), restored?.outputs ?? {});
  const known = new Set(graph.tasks.map(t => t.id));
  if (Object.keys(outputs).some(id => !known.has(id)) || graph.tasks.some(t => Object.hasOwn(outputs, t.id) && t.dependencies.some(id => !Object.hasOwn(outputs, id))))
    throw new Error("Graph checkpoint has an invalid completed dependency set");
  // Build adjacency once: O(nodes + edges), with no promise per dependency.
  const remaining = new Map<GraphTask, number>();
  const dependents = new Map<string, GraphTask[]>();
  const ready: GraphTask[] = [];
  for (const task of graph.tasks) {
    if (!task.id || dependents.has(task.id)) throw new Error(`Duplicate graph Node ID: ${task.id}`);
    for (const dependency of task.dependencies) {
      const children = dependents.get(dependency);
      if (!children) throw new Error(`Unknown or cyclic dependency: ${dependency}`);
      children.push(task);
    }
    dependents.set(task.id, []);
    const pending = task.dependencies.filter(id => !Object.hasOwn(outputs, id)).length;
    remaining.set(task, pending);
    if (!pending && !Object.hasOwn(outputs, task.id)) ready.push(task);
  }
  const runId = randomUUID();
  return new Promise<O>((resolve, reject) => {
    let cursor = 0, active = 0, failed = false;
    let saving = false, savedBoundary = "";
    const uncertain: string[] = [];
    let failure: unknown;
    const stop = (error: unknown): void => { if (!failed) { failed = true; failure = error; } };
    const pump = (): void => {
      if (saving) return;
      if (options.signal?.aborted) stop(options.signal.reason);
      if (checkpoint) {
        // Checkpoint mode runs ready waves; no resource is in flight while save is awaited.
        if (active) return;
        const boundary = `${Object.keys(outputs).length}:${uncertain.length}`;
        if (boundary !== savedBoundary) {
          saving = true;
          void Promise.resolve().then(() => checkpoint.save(checkpointState(`graph:${graph.id}`, checkpoint.version,
            { graphHash, inputHash, outputs, uncertain }))).then(() => {
              savedBoundary = boundary; saving = false; pump();
            }, reject);
          return;
        }
      }
      while (!failed && active < concurrency && cursor < ready.length) {
        const task = ready[cursor++]!;
        active++;
        void Promise.resolve().then(() => {
          options.signal?.throwIfAborted();
          const dependencies = Object.fromEntries(task.dependencies.map(id => [id, outputs[id]]));
          return invoke(task.node, task.bind(input, Object.freeze(dependencies)), {
            graphId: graph.id, runId, nodeId: task.id,
          });
        }).then(output => {
          outputs[task.id] = output;
          for (const child of dependents.get(task.id)!) {
            if (Object.hasOwn(outputs, child.id)) continue;
            const count = remaining.get(child)! - 1;
            remaining.set(child, count);
            if (!count) ready.push(child);
          }
        }, error => { uncertain.push(task.id); stop(error); }).finally(() => { active--; pump(); });
      }
      // Finish only after every started node settles, including on cancellation.
      if (!active) {
        if (failed) reject(failure);
        else resolve(Object.freeze(outputs) as O);
      }
    };
    pump();
  });
}

export interface RuntimeFlowResult<Output> {
  readonly output: Output;
  readonly context: Context;
}

export interface RagFlowInput {
  readonly context: Context;
  readonly query?: MessageContent;
  readonly corpus?: Reference;
  readonly limit?: number;
  readonly maxTokens?: number;
  readonly options?: JsonObject;
}

export interface SkillFlowInput {
  readonly context?: Context;
  /** Skill instructions/resources have already been resolved by the application or Runtime. */
  readonly sources: readonly ContextSource[];
}

export interface McpFlowInput {
  readonly context: Context;
  readonly request: InteractionMcpInput;
}

export interface InteractionFlowResult<Output> extends RuntimeFlowResult<Output> {
  readonly observation: Observation;
}

export interface ToolCallFlowInput {
  readonly context: Context;
  readonly call: ToolCall;
}

function stableIngressId(prefix: string, value: unknown): string {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

async function updateContext(
  runtime: RuntimeClient,
  context: Context,
  ingress: readonly ContextIngress[],
): Promise<Context> {
  return runtime.invoke("CONTEXT.UPDATE", { context, ingress });
}

function observationIngress(observation: Observation): readonly ContextIngress[] {
  return [{
    id: stableIngressId("observation", [observation.callId, observation]),
    sourceNode: "INTERACTION.OBSERVE",
    content: observation.message.content,
    metadata: {
      ...(observation.metadata ?? {}), callId: observation.callId,
      source: observation.source, status: observation.status,
      messageRole: observation.message.role,
      ...(observation.message.name === undefined ? {} : { messageName: observation.message.name }),
      ...(observation.error ? { errorCode: observation.error.code } : {}),
      ...(observation.references ? { references: observation.references.map(reference => ({ ...reference })) } : {}),
    },
  }];
}

/** RAG is an internal CONTEXT.SELECT strategy, not a public Node namespace. */
export async function runRagFlow(
  runtime: RuntimeClient,
  input: RagFlowInput,
): Promise<RuntimeFlowResult<ContextSelection>> {
  const output = await runtime.invoke("CONTEXT.SELECT", {
    context: input.context,
    purpose: "infer",
    strategy: {
      kind: "rag",
      ...(input.corpus === undefined ? {} : { corpus: input.corpus }),
      ...(input.options === undefined ? {} : { options: input.options }),
    },
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
  });
  return { output, context: output.context };
}

export async function runSkillFlow(
  runtime: RuntimeClient,
  input: SkillFlowInput,
): Promise<RuntimeFlowResult<Context>> {
  const loaded = await runtime.invoke("CONTEXT.LOAD", { sources: input.sources });
  const context = input.context === undefined
    ? loaded
    : await runtime.invoke("CONTEXT.UPDATE", { context: input.context, add: loaded.items });
  return { output: context, context };
}

export function runMcpFlow(
  runtime: RuntimeClient,
  input: McpFlowInput & { request: Extract<InteractionMcpInput, { operation: "discover" }> },
): Promise<RuntimeFlowResult<Extract<InteractionMcpOutput, { operation: "discover" }>>>;
export function runMcpFlow(
  runtime: RuntimeClient,
  input: McpFlowInput & { request: Extract<InteractionMcpInput, { operation: "invoke" }> },
): Promise<InteractionFlowResult<Extract<InteractionMcpOutput, { operation: "invoke" }>>>;
export function runMcpFlow(
  runtime: RuntimeClient,
  input: McpFlowInput,
): Promise<RuntimeFlowResult<InteractionMcpOutput> | InteractionFlowResult<InteractionMcpOutput>>;
export async function runMcpFlow(
  runtime: RuntimeClient,
  input: McpFlowInput,
): Promise<RuntimeFlowResult<InteractionMcpOutput> | InteractionFlowResult<InteractionMcpOutput>> {
  const output = await runtime.invoke("INTERACTION.ACT.MCP", input.request);
  if (output.operation !== input.request.operation) throw new Error("MCP operation mismatch");
  if (output.operation === "discover") return { output, context: input.context };
  if (input.request.operation !== "invoke" || output.result.callId !== input.request.call.id) throw new Error("MCP result callId mismatch");
  const observation = await runtime.invoke("INTERACTION.OBSERVE", { result: output.result });
  return { output, observation, context: await updateContext(runtime, input.context, observationIngress(observation)) };
}

export async function runToolCallFlow(
  runtime: RuntimeClient,
  input: ToolCallFlowInput,
): Promise<InteractionFlowResult<InteractionToolOutput>> {
  const output = await runtime.invoke("INTERACTION.ACT.TOOL", { call: input.call });
  if (output.callId !== input.call.id) throw new Error("Tool result callId mismatch");
  const observation = await runtime.invoke("INTERACTION.OBSERVE", { result: output });
  return { output, observation, context: await updateContext(runtime, input.context, observationIngress(observation)) };
}
