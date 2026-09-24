import { pathToFileURL } from "node:url";
import { createDitto, createContextWorker, graph } from "@codesoul-co/ditto";

/** A single-Graph API introduction; no model or persistent Agent state. */
export async function runContext(text = "Hello Ditto") {
  const runtime = createDitto({ workers: [createContextWorker()] });
  const plan = graph<string>("package-context")
    .node("loaded", "CONTEXT.LOAD", [], content => ({ sources: [{ role: "user", content }] }))
    .node("selected", "CONTEXT.SELECT", ["loaded"], (_input, { loaded }) => ({
      context: loaded, purpose: "infer", limit: 1,
    }));
  try { return (await runtime.run(plan, text)).selected; }
  finally { await runtime.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runContext(process.argv[2]), null, 2));
}
