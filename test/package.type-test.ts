// Check the documented package subpaths and declaration-merge extension surface.
import { createDitto, extendWorker } from "@ditto/core";
import type { NodeContract, InputOf } from "@ditto/core/contracts";
import type { MemoryRetrieveInput } from "@ditto/core/worker/memory";
import type { ContextLoadInput } from "@ditto/core/worker/context";
import { createGenerateNode } from "@ditto/core/worker/reasoning";
import { createInteractionNodes } from "@ditto/core/worker/interaction";
import { graph, loop, type LoopDefinition } from "@ditto/core/runtime";

declare module "@ditto/core/contracts" {
  interface NodeContractMap {
    "SEARCH.QUERY": NodeContract<{ query: string }, readonly { title: string }[]>;
  }
}

export function checkPackageSurface(): void {
  const input: InputOf<"SEARCH.QUERY"> = { query: "test" };
  const search = extendWorker("SEARCH", {
    nodes: { QUERY: async ({ query }) => [{ title: query }] },
  });
  const runtime = createDitto({ workers: [search] });
  void runtime.invoke("SEARCH.QUERY", input);
  const step = graph<string>().node("search", "SEARCH.QUERY", [], (query) => ({ query }));
  const plan: LoopDefinition<string, string, { search: readonly { title: string }[] }> = loop({
    graph: step, bind: (state: string) => state,
    update: (_state, output) => output.search[0]!.title, done: () => true,
  });
  const result: Promise<string> = runtime.loop(plan, "query");
  void result;
  // @ts-expect-error Public module augmentation retains the declared input.
  void runtime.invoke("SEARCH.QUERY", { messages: [] });
  const memory: MemoryRetrieveInput = { query: { role: "user", content: "hello" } };
  const context: ContextLoadInput = { sources: [memory.query] };
  void context; void createGenerateNode(); void createInteractionNodes();
}
