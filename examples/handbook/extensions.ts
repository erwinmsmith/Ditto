import { pathToFileURL } from "node:url";
import type { NodeContract } from "@codesoul-co/ditto/contracts";
import { defineNode, defineWorker } from "@codesoul-co/ditto/worker";
import { createDitto, graph } from "@codesoul-co/ditto/runtime";

declare module "@codesoul-co/ditto/contracts" {
  interface NodeContractMap {
    "EXAMPLE.HANDBOOK.TEXT.NORMALIZE": NodeContract<{ text: string }, { text: string }>;
    "EXAMPLE.HANDBOOK.TEXT.ANALYZE": NodeContract<{ text: string }, { text: string; characters: number; calls: number }>;
  }
}
type Resources = { calls: number };
const internal = graph<string>("normalize-private")
  .node("normalized", "EXAMPLE.HANDBOOK.TEXT.NORMALIZE", [], text => ({ text }));
export function textWorker() {
  return defineWorker<Resources>({
    type: "text", resources: () => ({ calls: 0 }), concurrency: 2,
    expose: ["EXAMPLE.HANDBOOK.TEXT.ANALYZE"],
    nodes: {
      "EXAMPLE.HANDBOOK.TEXT.NORMALIZE": defineNode<"EXAMPLE.HANDBOOK.TEXT.NORMALIZE", Resources>("text", "EXAMPLE.HANDBOOK.TEXT.NORMALIZE", async input => {
        if (typeof input.text !== "string" || input.text.length > 10_000) throw new TypeError("Invalid text");
        return { text: input.text.trim().normalize("NFC") };
      }),
      "EXAMPLE.HANDBOOK.TEXT.ANALYZE": async (input, ctx) => {
        ctx.signal?.throwIfAborted();
        const { normalized } = await ctx.run(internal, input.text);
        return { ...normalized, characters: [...normalized.text].length, calls: ++ctx.resources.calls };
      },
    },
  });
}
export async function runExtension(text = " Hello Ditto ") {
  const runtime = createDitto({ workers: [textWorker()] });
  const plan = graph<string>("analyze-text")
    .node("analysis", "EXAMPLE.HANDBOOK.TEXT.ANALYZE", [], text => ({ text }));
  try { return await runtime.run(plan, text); }
  finally { await runtime.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runExtension(process.argv[2]), null, 2));
}
