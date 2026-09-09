import type {
  InputOf,
  Message,
  NodeRequest,
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

const validRequest: NodeRequest<"REASONING.SAMPLE"> = {
  node: "REASONING.SAMPLE",
  input: { messages: [], count: 2 },
};

const invalidRequest: NodeRequest<"REASONING.SAMPLE"> = {
  node: "REASONING.SAMPLE",
  // @ts-expect-error count is fixed and required by the contract.
  input: { messages: [] },
};

void (null as unknown as InferInputIsFixed);
void (null as unknown as SampleOutputIsFixed);
void validRequest;
void invalidRequest;

// This body is compiled, never executed. Negative checks protect API inference.
import { createDitto, defineNode, defineWorker, graph } from "../src/index.js";
export function checkPublicTypes(): void {
  const runtime = createDitto();
  // @ts-expect-error Model providers are not automatically new semantic Nodes.
  runtime.invoke("REASONING.INFER.PROVIDER", { messages: [] });
  // @ts-expect-error SAMPLE keeps its required count.
  runtime.invoke("REASONING.SAMPLE", { messages: [] });
  // @ts-expect-error Runtime fields do not belong in Node input.
  runtime.invoke("REASONING.INFER", { messages: [], host: "remote" });
  // @ts-expect-error The output of INFER must be Message.
  defineNode("REASONING.INFER", async () => ({ items: [] }));
  defineWorker({ type: "MEMORY", nodes: {
    // @ts-expect-error A Worker declares Nodes in its own namespace.
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
  defineWorker<"REASONING", { model: string }>({ type: "REASONING", nodes: {
    "REASONING.INFER": async () => ({ role: "assistant", content: "ok" }),
  } });
  agent.node("later", "REASONING.REFLECT", ["infer"], (_input, outputs) => {
    // @ts-expect-error Only declared dependency outputs are available.
    void outputs.unknown;
    return { message: outputs.infer };
  });
}
