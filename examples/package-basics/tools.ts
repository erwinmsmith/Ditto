import { pathToFileURL } from "node:url";
import { createDitto, createInteractionWorker, graph } from "@codesoul-co/ditto";

/** Tool adapter introduction: application validation and result checking are explicit. */
export async function runTools(text = "Hello Ditto") {
  const runtime = createDitto({
    sandbox: { tools: ["count_characters"] },
    workers: [createInteractionWorker({ tools: [{
      name: "count_characters", effects: [],
      description: "Count Unicode code points in text",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      validate(args) { if (typeof args.text !== "string") throw new Error("text must be a string"); },
      async execute(args) { return { status: "success", structuredContent: { characters: [...String(args.text)].length } }; },
    }] })],
  });
  const plan = graph<string>("package-tools")
    .node("counted", "INTERACTION.ACT.TOOL", [], text => ({ call: { id: "count-1", name: "count_characters", arguments: { text } } }))
    .node("observed", "INTERACTION.OBSERVE", ["counted"], (_input, { counted }) => {
      if (counted.status !== "success") throw new Error(counted.error?.message ?? "Tool failed");
      return { result: counted };
    });
  try { return await runtime.run(plan, text); }
  finally { await runtime.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runTools(process.argv[2]), null, 2));
}
