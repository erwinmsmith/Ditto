import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createDitto, graph, graphStep, loop, loadRuntimeConfig, type GraphPlan, type RuntimeConfig } from "@codesoul-co/ditto/runtime";
import type { NodeResult } from "@codesoul-co/ditto/contracts";
import { createInferWorker, type ModelConfig } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "../_shared/tools/storage/workers.ts";
import { answerFiles } from "../_shared/tools/package-basics.ts";

export interface AgentRequest { session: string; turn: string; prompt: string; }
interface TextMessage { role: "user" | "assistant"; content: string; }
interface Conversation { turn: string; prompt: string; answer: string; messages: TextMessage[]; }
export interface AgentResult { answer: string; file: string; replayed: boolean; }
interface TurnInput extends AgentRequest { model: ModelConfig; }
const key = (session: string) => `package-basics:${session}:conversation`;
const scope = (input: AgentRequest) => ({ sessionId: `package-basics:${input.session}`, turnId: input.turn });
function success<T>(result: NodeResult<T>): T {
  if (result.status !== "success" || result.output === undefined) throw new Error(result.error?.message ?? `Worker ${result.node} failed`);
  return result.output;
}
function conversation(value: unknown): Conversation {
  if (!value || typeof value !== "object") throw new Error("Invalid stored conversation");
  const v = value as Partial<Conversation>;
  if (typeof v.turn !== "string" || typeof v.prompt !== "string" || typeof v.answer !== "string" || !Array.isArray(v.messages)
    || !v.messages.every(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string")) throw new Error("Invalid stored conversation");
  return v as Conversation;
}
const historyGraph = graph<AgentRequest>("package-history")
  .node("history", "MEMORY.GET", [], input => ({ keys: [key(input.session)] }));
const answerGraph = graph<TurnInput & { history: TextMessage[] }>("package-answer")
  .node("loaded", "CONTEXT.LOAD", [], input => ({ scope: scope(input), sources: [
    { role: "system", content: "Answer the user's request accurately and concisely. Use the supplied conversation history when relevant." },
    ...input.history.map((message, index) => ({ id: `history-${index}`, content: message.content, metadata: { role: message.role, sourceType: "message" } })),
    { id: "current-user", content: input.prompt, metadata: { role: "user", currentGoal: true } },
  ] }))
  .node("selected", "CONTEXT.SELECT", ["loaded"], input => ({ scope: scope(input), purpose: "infer" }))
  .node("answer", "INFER.REASONING.SAMPLE", ["selected"], (input, { selected }) => ({
    messages: selected.context.items.map(item => {
      const role = item.metadata?.role;
      if (typeof item.content !== "string" || (role !== "system" && role !== "user" && role !== "assistant")) throw new Error("Expected text conversation context");
      return { role, content: item.content };
    }),
    model: input.model, generation: { maxTokens: 512 },
  }))
  .node("updated", "CONTEXT.UPDATE", ["answer"], (input, { answer }) => {
    const content = success(answer).message.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("Model returned no text answer");
    return { scope: scope(input), add: [{ id: "assistant-answer", content, metadata: { role: "assistant" } }] };
  });
interface SaveInput { session: string; id?: string; content: Conversation; }
const writeGraph = graph<SaveInput>("package-memory-write")
  .node("saved", "MEMORY.WRITE", [], input => ({ memories: [{ key: key(input.session), content: input.content }] }));
const updateGraph = graph<SaveInput>("package-memory-update")
  .node("saved", "MEMORY.UPDATE", [], input => ({ memories: [{ id: input.id!, content: input.content }] }));
const outputGraph = graph<{ turn: string; answer: string }>("package-output")
  .node("receipt", "INTERACTION.OUTPUT", [], input => ({ deliveryId: input.turn, message: { role: "assistant", content: input.answer } }));

export const conversationPlan = loop({
  id: "package-conversation", maxIterations: 4,
  *plan(input: TurnInput): GraphPlan<{ answer: string; replayed: boolean }> {
    const loaded = yield* graphStep(historyGraph, input);
    const existing = success(loaded.history)[0];
    const previous = existing ? conversation(existing.content) : undefined;
    if (previous?.turn === input.turn) {
      if (previous.prompt !== input.prompt) throw new Error("A turn ID cannot be reused with a different prompt");
      const delivered = yield* graphStep(outputGraph, { turn: input.turn, answer: previous.answer });
      if (delivered.receipt.status !== "accepted") throw new Error("Answer delivery was not accepted");
      return { answer: previous.answer, replayed: true };
    }
    const history = previous?.messages.slice(-10) ?? [];
    const generated = yield* graphStep(answerGraph, { ...input, history });
    const answer = success(generated.answer).message.content;
    if (typeof answer !== "string" || !answer.trim()) throw new Error("Model returned no text answer");
    const content: Conversation = { turn: input.turn, prompt: input.prompt, answer,
      messages: [...history, { role: "user", content: input.prompt }, { role: "assistant", content: answer }] };
    const saved = yield* graphStep(existing ? updateGraph : writeGraph, {
      session: input.session, ...(existing ? { id: existing.id } : {}), content,
    });
    success(saved.saved);
    const delivered = yield* graphStep(outputGraph, { turn: input.turn, answer });
    if (delivered.receipt.status !== "accepted") throw new Error("Answer delivery was not accepted");
    return { answer, replayed: false };
  },
});

/** The trusted host owns configuration, session identity and storage location. */
export async function runAgent(request: AgentRequest, directory: string, config: RuntimeConfig): Promise<AgentResult> {
  if (![request.session, request.turn].every(id => /^[a-zA-Z0-9_-]{1,64}$/.test(id)) || !request.prompt.trim() || request.prompt.length > 8000) {
    throw new Error("Use bounded session/turn IDs and a nonempty prompt of at most 8000 characters");
  }
  if (!config.model) throw new Error("Configure DITTO_WORKER_INFER_MODEL_PROVIDER and DITTO_WORKER_INFER_MODEL");
  const dir = resolve(directory, request.session);
  await mkdir(dir, { recursive: true });
  const storage = await openAgentStorage(dir, config);
  try {
    const runtime = createDitto({ config, workers: [...storage.workers, createInferWorker(),
      createInteractionWorker({ output: answerFiles(join(dir, "answers")) })] });
    try {
      const result = await runtime.loop(conversationPlan, { ...request, model: config.model }, { signal: AbortSignal.timeout(120_000) });
      return { ...result, file: join(dir, "answers", `${request.turn}.md`) };
    } finally { await runtime.close(); }
  } finally { await storage.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    session: { type: "string", default: "demo" }, turn: { type: "string" }, prompt: { type: "string" },
    directory: { type: "string", default: ".examples-package-basics-tasks" },
  } });
  if (!values.turn || !values.prompt) throw new Error("Pass --turn <unique-turn-id> and --prompt <text>");
  const config = loadRuntimeConfig(process.env, { runtime: { timeoutMs: 60_000 }, workers: { context: { cache: { ttlMs: 300_000 } } } });
  console.log(JSON.stringify(await runAgent({ session: values.session!, turn: values.turn, prompt: values.prompt }, values.directory!, config), null, 2));
}
