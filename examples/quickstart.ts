import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createDitto, graph, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";

// example: quickstart
export async function quickstart() {
  const config = loadRuntimeConfigFile("ditto.yaml", {});
  const runtime = createDitto({ config, workers: [createContextWorker({ policy: config.context.policy ?? {} })] });
  const plan = graph<string>("first-context")
    .node("loaded", "CONTEXT.LOAD", [], text => ({ sources: [{ role: "user", content: text }] }))
    .node("selected", "CONTEXT.SELECT", ["loaded"], (_input, { loaded }) => ({
      context: loaded, purpose: "infer", limit: 1,
    }));
  try {
    const output = await runtime.run(plan, "Hello Ditto", { concurrency: 2 });
    assert.equal(output.selected.context.items[0]?.content, "Hello Ditto");
    return output.selected;
  } finally { await runtime.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await quickstart());
}
