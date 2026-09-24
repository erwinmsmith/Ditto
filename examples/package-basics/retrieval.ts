import { pathToFileURL } from "node:url";
import { createDitto, graph } from "@codesoul-co/ditto";
import { createRetrievalWorker, createTextSearchProvider, RetrievalTargetRegistry } from "@codesoul-co/ditto-retrieval";

/** Provider wiring example; the tiny application-owned corpus is not a database. */
export async function runRetrieval(query = "Redis") {
  const documents = [
    { id: "context", content: "Redis stores short-lived working context.", source: { ref: "guide.md#context" } },
    { id: "memory", content: "SQLite stores durable conversation memory.", source: { ref: "guide.md#memory" } },
  ];
  const provider = createTextSearchProvider({ async search(input) {
    const words = String(input.query.content).toLowerCase().split(/\s+/).filter(Boolean);
    return { target: input.target, candidates: documents.filter(doc => words.every(word => doc.content.toLowerCase().includes(word))).slice(0, input.limit ?? 5) };
  } });
  const providers = new RetrievalTargetRegistry({ guide: { defaultStrategy: "keyword", providers: { keyword: provider } } });
  const runtime = createDitto({ workers: [createRetrievalWorker({ providers })] });
  const plan = graph<string>("package-retrieval")
    .node("searched", "RETRIEVAL.SEARCH", [], content => ({ query: { content }, target: { name: "guide" }, limit: 5 }));
  try {
    const { searched } = await runtime.run(plan, query);
    if (searched.status !== "success" || !searched.output) throw new Error(searched.error?.message ?? "Retrieval failed");
    return searched.output;
  } finally { await runtime.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runRetrieval(process.argv[2]), null, 2));
}
