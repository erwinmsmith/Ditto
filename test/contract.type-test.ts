import type { InputOf, NodeType, OutputOf } from "../src/index.js";
import type { TrajectoryInput, TrajectoryOutput } from "../src/worker/infer/index.js";

const nodeTypes = {
  "INFER.REASONING.TRAJECTORY": true,
  "INFER.REASONING.REFLECT": true,
  "INFER.REASONING.DELIBERATE": true,
  "INFER.REASONING.SAMPLE": true,
  "CONTEXT.LOAD": true,
  "CONTEXT.SELECT": true,
  "CONTEXT.UPDATE": true,
  "CONTEXT.COMPRESS": true,
  "CONTEXT.RAG.EMBED": true,
  "CONTEXT.RAG.RETRIEVE": true,
  "CONTEXT.RAG.RANK": true,
  "CONTEXT.SKILL": true,
  "MEMORY.RETRIEVE": true,
  "MEMORY.WRITE": true,
  "MEMORY.UPDATE": true,
  "MEMORY.CONSOLIDATE": true,
  "MEMORY.EVICT": true,
  "MEMORY.RAG.EMBED": true,
  "MEMORY.RAG.RETRIEVE": true,
  "MEMORY.RAG.RANK": true,
  "MEMORY.SKILL": true,
  "INTERACTION.ACT.TOOL": true,
  "INTERACTION.ACT.MCP": true,
  "INTERACTION.OBSERVE": true,
  "INTERACTION.OUTPUT": true,
} as const satisfies Record<Exclude<NodeType, "MEMORY.ARCHIVE" | "BROWSER.OPEN">, true>;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type _Input = Expect<Equal<InputOf<"INFER.REASONING.TRAJECTORY">, TrajectoryInput>>;
type _Output = Expect<Equal<OutputOf<"INFER.REASONING.TRAJECTORY">, TrajectoryOutput>>;

// @ts-expect-error REASONING is a folder, not a routable namespace.
const legacyNode: NodeType = "REASONING.INFER";
// @ts-expect-error CACHE has no agreed leaf contract yet.
const cacheNamespace: NodeType = "INFER.CACHE";

void nodeTypes;
void (null as unknown as _Input);
void (null as unknown as _Output);
void legacyNode;
void cacheNamespace;
