import type {
  InputOf,
  Message,
  OutputOf,
} from "../src/index.js";

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends
  (<T>() => T extends TRight ? 1 : 2)
    ? true
    : false;

type Expect<T extends true> = T;

type InferInputIsFixed = Expect<
  Equal<InputOf<"REASONING.INFER">, { messages: readonly Message[] }>
>;

type SampleOutputIsFixed = Expect<
  Equal<OutputOf<"REASONING.SAMPLE">, readonly Message[]>
>;

const validRequest: InputOf<"REASONING.SAMPLE"> = { messages: [], count: 2 };

// @ts-expect-error count is fixed and required by the contract.
const invalidRequest: InputOf<"REASONING.SAMPLE"> = { messages: [] };

void (null as unknown as InferInputIsFixed);
void (null as unknown as SampleOutputIsFixed);
void validRequest;
void invalidRequest;

// This body is compiled, never executed. Negative checks protect API inference.
import { createDitto, defineNode, defineWorker, extendWorker, graph, createInteractionNodes } from "../src/index.js";
export function checkPublicTypes(): void {
  const runtime = createDitto();
  extendWorker("MEMORY", { nodes: {
    // @ts-expect-error Operation belongs to reasoning, not the memory namespace.
    INFER: async () => ({ role: "assistant", content: "wrong namespace" }),
  } });
  extendWorker("MEMORY", { nodes: {
    // @ts-expect-error Scoped operations retain their fixed output contracts.
    RETRIEVE: async () => "not memory items",
  } });
  // @ts-expect-error The removed independent AGENT namespace is not a capability.
  runtime.invoke("AGENT.RUN", { messages: [] });
  defineWorker({ type: "assistant", resources: () => ({ count: 0 }),
    nodes: createInteractionNodes<{ count: number }>(), expose: ["INTERACTION.RUN"],
  });
  // @ts-expect-error Tool arguments must be a JSON object.
  runtime.invoke("INTERACTION.TOOL", { name: "echo", arguments: "bad" });
  // @ts-expect-error Model providers are not automatically new semantic Nodes.
  runtime.invoke("REASONING.INFER.PROVIDER", { messages: [] });
  // @ts-expect-error SAMPLE keeps its required count.
  runtime.invoke("REASONING.SAMPLE", { messages: [] });
  // @ts-expect-error Runtime fields do not belong in Node input.
  runtime.invoke("REASONING.INFER", { messages: [], host: "remote" });
  // @ts-expect-error The output of INFER must be Message.
  defineNode("REASONING.INFER", async () => ({ items: [] }));
  defineWorker({ type: "MEMORY", nodes: {
    // Deployment roles may compose Nodes from any semantic namespace.
    "REASONING.INFER": async () => ({ role: "assistant", content: "bad" }),
  } });
  defineWorker({ type: "REASONING", nodes: {
    // @ts-expect-error An implementation cannot change fixed output shape.
    "REASONING.INFER": async () => ({ items: [] }),
  } });
  // @ts-expect-error Graph binder must return InferInput, not Context.
  graph<string>().node("infer", "REASONING.INFER", [], () => ({ items: [] }));
  const agent = graph<string>().node("infer", "REASONING.INFER", [], () => ({ messages: [] }));
  // @ts-expect-error Runtime cannot widen the Graph input type to fit a caller.
  runtime.run(agent, 1);
  // @ts-expect-error Declared resources must have an instance factory.
  defineWorker<{ model: string }>({ type: "REASONING", nodes: {
    "REASONING.INFER": async () => ({ role: "assistant", content: "ok" }),
  } });
  agent.node("later", "REASONING.REFLECT", ["infer"], (_input, outputs) => {
    // @ts-expect-error Only declared dependency outputs are available.
    void outputs.unknown;
    return { message: outputs.infer };
  });
}
