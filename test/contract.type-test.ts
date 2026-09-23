import type { InputOf, NodeType, OutputOf } from "../src/index.js";
import type { TrajectoryInput, TrajectoryOutput, NodeResult } from "../src/worker/infer/index.js";

const nodeTypes = {
  "INFER.REASONING.TRAJECTORY": true,
  "INFER.REASONING.REFLECT": true,
  "INFER.REASONING.DELIBERATE": true,
  "INFER.REASONING.SAMPLE": true,
  "INFER.CACHE.LOOKUP": true,
  "INFER.CACHE.WRITE": true,
  "INFER.CACHE.INVALIDATE": true,
  "CONTEXT.LOAD": true,
  "CONTEXT.SELECT": true,
  "CONTEXT.UPDATE": true,
  "CONTEXT.COMPRESS": true,
  "MEMORY.GET": true,
  "MEMORY.QUERY": true,
  "MEMORY.SEARCH": true,
  "MEMORY.WRITE": true,
  "MEMORY.UPDATE": true,
  "MEMORY.DELETE": true,
  "INTERACTION.ACT.TOOL": true,
  "INTERACTION.ACT.MCP": true,
  "INTERACTION.OBSERVE": true,
  "INTERACTION.OUTPUT": true,
} as const satisfies Record<Exclude<NodeType, "MEMORY.ARCHIVE" | "BROWSER.OPEN" | "RETRIEVAL.SEARCH" | `EXAMPLE.${string}`>, true>;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type _Input = Expect<Equal<InputOf<"INFER.REASONING.TRAJECTORY">, TrajectoryInput>>;
type _Output = Expect<Equal<OutputOf<"INFER.REASONING.TRAJECTORY">, NodeResult<TrajectoryOutput>>>;

// @ts-expect-error REASONING is a folder, not a routable namespace.
const legacyNode: NodeType = "REASONING.INFER";
// @ts-expect-error CACHE is a namespace, not a routable leaf.
const cacheNamespace: NodeType = "INFER.CACHE";

void nodeTypes;
void (null as unknown as _Input);
void (null as unknown as _Output);
void legacyNode;
void cacheNamespace;
