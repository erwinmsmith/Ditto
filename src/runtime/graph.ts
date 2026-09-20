import { createHash, randomUUID } from "node:crypto";
import type { ExecutionScope } from "./communication/transport.js";
import type { InputOf, NodeType, OutputOf } from "../contracts/index.js";
import type {
  Context, ContextIngress, KnowledgeItem, Observation,
  MessageContent, Reference, ToolCall,
} from "../contracts/common.js";
import type { RuntimeClient } from "../worker/execution-context.js";
import type { ContextRagRankOutput } from "../worker/context/contracts.js";
import type { InteractionMcpInput, InteractionMcpOutput, InteractionToolOutput } from "../worker/interaction/contracts.js";
import type { MemoryRagRankOutput, MemorySkillOutput } from "../worker/memory/contracts.js";

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

export interface ContextRagFlowInput {
  readonly scope: "context";
  readonly context: Context;
  readonly query: MessageContent;
  readonly corpus: Reference | readonly KnowledgeItem[];
  readonly limit?: number;
  readonly strategy?: string;
}

export interface MemoryRagFlowInput {
  readonly scope: "memory";
  readonly context: Context;
  readonly query: MessageContent;
  readonly corpus?: Reference;
  readonly limit?: number;
  readonly strategy?: string;
}

export type RagFlowInput = ContextRagFlowInput | MemoryRagFlowInput;

export interface SkillFlowInput {
  readonly context: Context;
  readonly name: string;
  readonly version?: string;
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

function contextRagIngress(candidates: ContextRagRankOutput): readonly ContextIngress[] {
  return candidates.map(({ item, score }) => ({
    id: stableIngressId("context-rag", item.id),
    sourceNode: "CONTEXT.RAG.RANK",
    content: item.content,
    ...(item.source ? { reference: item.source } : {}),
    metadata: { ...(item.metadata ?? {}), itemId: item.id, ...(score === undefined ? {} : { score }) },
  }));
}

function memoryRagIngress(candidates: MemoryRagRankOutput): readonly ContextIngress[] {
  return candidates.map(({ memory, score }) => ({
    id: stableIngressId("memory-rag", memory.id),
    sourceNode: "MEMORY.RAG.RANK",
    content: memory.message.content,
    metadata: {
      ...(memory.metadata ?? {}),
      memoryId: memory.id,
      ...(memory.key === undefined ? {} : { memoryKey: memory.key }),
      ...(score === undefined ? {} : { score }),
    },
  }));
}

function skillIngress(skill: MemorySkillOutput): readonly ContextIngress[] {
  return [{
    id: stableIngressId("skill", [skill.name, skill.version ?? null]),
    sourceNode: "MEMORY.SKILL",
    content: skill.instructions,
    metadata: {
      ...(skill.metadata ?? {}),
      name: skill.name,
      ...(skill.version === undefined ? {} : { version: skill.version }),
    },
  }];
}

function observationIngress(observation: Observation): readonly ContextIngress[] {
  return [{
    id: stableIngressId("observation", [observation.callId, observation]),
    sourceNode: "INTERACTION.OBSERVE",
    content: observation.message.content,
    metadata: {
      ...(observation.metadata ?? {}), callId: observation.callId,
      source: observation.source, status: observation.status,
      ...(observation.error ? { errorCode: observation.error.code } : {}),
      ...(observation.references ? { references: observation.references.map(reference => ({ ...reference })) } : {}),
    },
  }];
}

/** Standard query-time RAG flow. EMBED remains an index-preparation operation. */
export function runRagFlow(
  runtime: RuntimeClient,
  input: ContextRagFlowInput,
): Promise<RuntimeFlowResult<ContextRagRankOutput>>;
export function runRagFlow(
  runtime: RuntimeClient,
  input: MemoryRagFlowInput,
): Promise<RuntimeFlowResult<MemoryRagRankOutput>>;
export async function runRagFlow(
  runtime: RuntimeClient,
  input: RagFlowInput,
): Promise<RuntimeFlowResult<ContextRagRankOutput | MemoryRagRankOutput>> {
  const options = {
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
  };
  if (input.scope === "context") {
    const candidates = await runtime.invoke("CONTEXT.RAG.RETRIEVE", {
      query: input.query,
      corpus: input.corpus,
      ...options,
    });
    const output = await runtime.invoke("CONTEXT.RAG.RANK", {
      query: input.query,
      candidates,
      ...options,
    });
    return { output, context: await updateContext(runtime, input.context, contextRagIngress(output)) };
  }
  const candidates = await runtime.invoke("MEMORY.RAG.RETRIEVE", {
    query: input.query,
    ...(input.corpus === undefined ? {} : { corpus: input.corpus }),
    ...options,
  });
  const output = await runtime.invoke("MEMORY.RAG.RANK", {
    query: input.query,
    candidates,
    ...options,
  });
  return { output, context: await updateContext(runtime, input.context, memoryRagIngress(output)) };
}

export async function runSkillFlow(
  runtime: RuntimeClient,
  input: SkillFlowInput,
): Promise<RuntimeFlowResult<MemorySkillOutput>> {
  const output = await runtime.invoke("MEMORY.SKILL", {
    name: input.name,
    ...(input.version === undefined ? {} : { version: input.version }),
  });
  return { output, context: await updateContext(runtime, input.context, skillIngress(output)) };
}

export function runMcpFlow(
  runtime: RuntimeClient,
  input: McpFlowInput & { request: Extract<InteractionMcpInput, { operation: "discover" }> },
): Promise<RuntimeFlowResult<Extract<InteractionMcpOutput, { operation: "discover" }>>>;
export function runMcpFlow(
  runtime: RuntimeClient,
  input: McpFlowInput & { request: Extract<InteractionMcpInput, { operation: "invoke" }> },
): Promise<InteractionFlowResult<Extract<InteractionMcpOutput, { operation: "invoke" }>>>;
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
