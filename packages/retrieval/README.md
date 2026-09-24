# Ditto Retrieval

`@codesoul-co/ditto-retrieval` is the optional retrieval Worker and provider package for `@codesoul-co/ditto`. It adds `RETRIEVAL.SEARCH` and adapters for Memory and Context. It does not own your corpus, database connections or RAG application plan.

## Install

Requires Node.js 24+, npm 11+ and ESM:

```sh
npm init -y
npm pkg set type=module
npm install @codesoul-co/ditto @codesoul-co/ditto-retrieval
```

The main package is a peer dependency. Importing retrieval does not register a Worker or start a service. The main package works independently when retrieval is not installed.

## Run a search

Save as `search.mjs` and run `node search.mjs`:

```js
import { createDitto, graph } from "@codesoul-co/ditto";
import {
  createRetrievalWorker,
  createTextSearchProvider,
  RetrievalTargetRegistry,
} from "@codesoul-co/ditto-retrieval";

const documents = [
  { id: "context", content: "Redis stores working context.", source: { ref: "guide.md#context" } },
  { id: "memory", content: "SQLite stores durable memory.", source: { ref: "guide.md#memory" } },
];
const provider = createTextSearchProvider({
  async search(input) {
    const query = String(input.query.content).toLowerCase();
    return {
      target: input.target,
      candidates: documents.filter(doc => doc.content.toLowerCase().includes(query)).slice(0, input.limit ?? 5),
    };
  },
});
const providers = new RetrievalTargetRegistry({
  guide: { defaultStrategy: "keyword", providers: { keyword: provider } },
});
const runtime = createDitto({ workers: [createRetrievalWorker({ providers })] });
const plan = graph("search-guide")
  .node("found", "RETRIEVAL.SEARCH", [], query => ({
    query: { content: query }, target: { name: "guide" }, limit: 5,
  }));
try {
  const { found } = await runtime.run(plan, "Redis");
  if (found.status !== "success" || !found.output) {
    throw new Error(found.error?.message ?? "Retrieval failed");
  }
  console.log(found.output.candidates);
} finally { await runtime.close(); }
```

Expected result: the `context` document with its source reference. This is a tiny application-owned keyword corpus, not a vector database. For real data, inject a database/search backend and enforce target, namespace and tenant authorization in the application.

## Public entries

| Import | Purpose |
| --- | --- |
| `@codesoul-co/ditto-retrieval` | Worker factory, contracts, target registry, text/vector/hybrid/rerank/embedding providers and database adapters |
| `@codesoul-co/ditto-retrieval/adapters/memory` | Memory ↔ retrieval adapters and candidate mapping |
| `@codesoul-co/ditto-retrieval/adapters/context` | Context RAG selection strategy and candidate mapping |

```ts
import { RemoteRetrievalSearchProvider } from "@codesoul-co/ditto-retrieval/adapters/memory";
import { createRetrievalContextStrategy } from "@codesoul-co/ditto-retrieval/adapters/context";
```

Importing the package adds the `RETRIEVAL.SEARCH` contract to Ditto's open NodeContractMap. A separate Worker registration is still required for Runtime execution. Consumers should use NodeNext module resolution without source aliases. Do not import the old main-package `/worker/retrieval` subpath or private `src`/`dist` files.

## Complete guides and applications

- [Detailed npm guide](https://github.com/erwinmsmith/Ditto/blob/main/docs/package-guide.md) · [详细中文教程](https://github.com/erwinmsmith/Ditto/blob/main/docs/package-guide.zh-CN.md)
- [Retrieval API](https://github.com/erwinmsmith/Ditto/blob/main/docs/worker-api/retrieval.md): inputs, result status, target registration and independent deployment.
- [Provider and database guide](https://github.com/erwinmsmith/Ditto/blob/main/docs/worker-api/retrieval-providers.md): embeddings, SQL/full-text/vector search, hybrid fusion and reranking.
- [Runnable basics](https://github.com/erwinmsmith/Ditto/tree/main/examples/package-basics): separate main-package and optional-package examples.
- [Complete RAG application](https://github.com/erwinmsmith/Ditto/tree/main/examples/patterns/rag-qa): request → search → selection → Redis Context → model answer → citation checks → durable output.

RAG is an application Graph/Loop composition. Retrieval supplies search capability; Memory persists approved internal knowledge and task state, while external knowledge databases use separately configured providers. SDK dependencies and connection lifecycle remain application owned.
