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

export async function runGraph<I, O extends object>(
  graph: ExecutionGraph<I, O>,
  input: I,
  invoke: (node: NodeType, input: unknown, scope: ExecutionScope) => Promise<unknown>,
): Promise<O> {
  // Validate the whole plan before executing anything (also protects JS callers).
  const known = new Set<string>();
  for (const task of graph.tasks) {
    if (!task.id || known.has(task.id)) throw new Error(`Duplicate graph Node ID: ${task.id}`);
    for (const dependency of task.dependencies) {
      if (!known.has(dependency)) throw new Error(`Unknown or cyclic dependency: ${dependency}`);
    }
    known.add(task.id);
  }
  const runId = randomUUID();
  const outputs: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const jobs = new Map<string, Promise<void>>();
  for (const task of graph.tasks) {
    const job = Promise.all(task.dependencies.map((id) => jobs.get(id)!)).then(async () => {
      const dependencies = Object.fromEntries(task.dependencies.map((id) => [id, outputs[id]]));
      outputs[task.id] = await invoke(task.node, task.bind(input, Object.freeze(dependencies)), {
        graphId: graph.id, runId, nodeId: task.id,
      });
    });
    jobs.set(task.id, job);
  }
  // Drain already-started branches before rejecting. No hidden work after run settles.
  const settled = await Promise.allSettled(jobs.values());
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return Object.freeze(outputs) as O;
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
