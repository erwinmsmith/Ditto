import {
  createBraveWebSearchProvider, createContextWorker, createDitto, createInteractionWorker,
  createWebSearchTool, runToolCallFlow,
} from "../dist/index.js";

const origin = "https://api.search.brave.com";

async function main() {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) throw new Error("BRAVE_SEARCH_API_KEY is required for the live web search check");
  const provider = createBraveWebSearchProvider({ apiKey });
  const tool = createWebSearchTool({ provider });
  const runtime = createDitto({
    sandbox: { tools: [tool.name], network: [origin] },
    workers: [createInteractionWorker({ tools: [tool] }), createContextWorker()],
  });
  try {
    const result = await runToolCallFlow(runtime, {
      context: { items: [] },
      call: { id: "web-search-live", name: "web_search", arguments: {
        query: process.argv.slice(2).join(" ") || "Ditto agent runtime", limit: 3,
      } },
    });
    if (result.output.status !== "success" || !result.output.references?.length || result.context.items.length !== 1) {
      throw new Error(result.output.error?.message ?? "Live web search returned no observable results");
    }
    console.log(JSON.stringify({ status: result.output.status, results: result.output.structuredContent,
      observationSource: result.observation.source, contextItems: result.context.items.length }));
  } finally { await runtime.close(); }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Live web search check failed");
  process.exitCode = 1;
});
