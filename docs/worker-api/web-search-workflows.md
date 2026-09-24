# Web search question answering through public APIs

[简体中文](web-search-workflows.zh-CN.md) · [API index](README.md) · [Full example](../../examples/patterns/web-search-qa/README.md)

`runWebQa` and `runWebQaLoop` belong to the application example. Core provides the public Runtime, Loop, Graph, Worker and WebSearchProvider contracts. All stage Graphs are scheduled by one Loop; the plan does not call Runtime.run or Worker executors.

## Runnable package consumer

Use Node.js 24+, an installed `@codesoul-co/ditto` package or tarball, Redis, a configured text model, and `redis` / `linkedom` dependencies. Copy the example and its application dependency closure: `examples/patterns/web-search-qa`, `examples/_shared/tools/web-search`, `examples/_shared/tools/storage`, `examples/_shared/tools/evidence.ts`, `examples/_shared/tools/execution/files.ts`, and `examples/_shared/tools/retrieval/{web.ts,domain.ts,dependencies/package.json}`. Save the following at the consumer root as `web-search-client.ts`:

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createTask } from "./examples/_shared/tools/web-search/adapters.ts";
import { searchConfig } from "./examples/_shared/tools/web-search/providers.ts";
import { defaultRequest } from "./examples/patterns/web-search-qa/fixtures.ts";
import { openWebQa } from "./examples/patterns/web-search-qa/cli.ts";
import { runWebQa } from "./examples/patterns/web-search-qa/index.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = process.env.EXAMPLE_WEB_PROVIDER ?? config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure model");
await mkdir(".examples-web-search-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-web-search-tasks/consumer-"));
const search = searchConfig();
const request = await createTask(directory, defaultRequest(), search);
const app = await openWebQa(directory, request, config, search);
try {
  const result = await runWebQa(app.runtime, { request, model: { provider, model } }, {
    signal: AbortSignal.timeout(300_000)
  });
  if ("status" in result) throw new Error("Unexpected checkpoint");
  console.log(JSON.stringify({ directory, answer: result.answer }, null, 2));
} finally { await app.close(); }
```

Run `node --env-file=.env web-search-client.ts`. `defaultRequest` is an explicit public-data demonstration identity; a host application supplies authenticated tenant/principal, question, network policy and budgets through `createTask` instead.

## API and composition

| Public API | Stage contract |
| --- | --- |
| `loop`, `graphStep`, `runtime.loop` | One plan, heterogeneous stage inputs/outputs, 128-Graph budget, cancellation and trace |
| `graph().node()` | Stage-local Worker-node dependencies; no nested Graphs |
| Context Worker `CONTEXT.LOAD` | Redis scope `web:tenant:principal:id`; request and current working set |
| Memory Worker `MEMORY.GET/WRITE` | Persistent request binding, plan, per-query results, discovered URLs, read evidence, selection and report |
| Infer Worker `INFER.REASONING.SAMPLE` | Understanding/query generation, filtering/conflict analysis, answer, grounding review |
| Interaction Worker `INTERACTION.ACT.TOOL` | Authorized search, actual page reading, snapshot checks and publication |
| `createWebSearchTool({provider})` | Public WebSearchProvider injection; snippets remain discovery metadata |

Worker factories are imported from `@codesoul-co/ditto/worker/{context,memory,infer,interaction}`. `createDitto`, `graph`, `loop`, `graphStep` come from `@codesoul-co/ditto/runtime`. No framework-specific business nodes or third-party framework dependencies are required.

The direct form is `runtime.loop(runWebQaLoop, [input, options], {signal, onGraph})`; `runWebQa()` is the convenience wrapper and forwards its signal to the enclosing Loop. Every cancellation terminates further Graph scheduling. `onGraph` is an actual execution trace, not a static enumeration of all branches.

## Application request and result

`Request` has `id`, `tenant`, `principal`, `question`, `allowedOrigins`, `referenceUrls`, `maxQueries` (1–3), `maxPages` (1–6), `crossCheck` and `allowPartial`. These identity, network, reference and budget fields are trusted controller inputs, never model-granted permissions. Questions or policy changes require a new task ID. References supplement search and must also be read; they do not bypass search or citation validation.

`Options.stopAfter` accepts `plan`, `searched`, `read`, `selected`, `report`. A stopped task returns `{status:"checkpoint",stage}`. A completed task returns a `Report` with the normalized question, query plan, selection/missing facets/conflicts, selected page evidence, answer, failures, omitted URLs, per-claim verification and generation timestamp. Answer statuses: `answered`, `insufficient-evidence`, `conflicting-evidence`, `needs-clarification`.

Each cited chunk includes its final URL, title, retrieval timestamp, raw HTML SHA256 and normalized paragraph location. Quotes must be nonempty exact substrings of selected, stored page text. Search snippets cannot be quoted as evidence. The model must preserve units, qualifications and negation; a separate real model call checks grounding. At most one answer repair is allowed, for at most six model calls per uninterrupted complete run. Invalid drafts never publish. Transport/model/storage errors are not content repair requests.

`crossCheck=true` requires each ordinary answered claim to have supporting quotes from at least two origins and different text. Mirrors are deduplicated. Different origins are a measurable corroboration heuristic, not proof of editorial independence or universal factual truth. Conflicts cite both sides and remain unresolved rather than assigning an arbitrary winner. Failed sources and page-budget omissions remain visible even when other sources answer the question.

## Storage, authorization and recovery

Redis stores working Context; the example's Memory Worker uses file SQLite. Snapshot files store HTML and decoded paragraphs; the output is immutable JSON plus Markdown. These files do not replace Memory. This example's acceptance does not imply PostgreSQL/vector-store acceptance; other Memory backends can be registered through the existing public MemoryStore API.

Only missing/expired Context may be rebuilt from Memory; Redis and database outages propagate. Restart the same request and provider after a stop or process crash. Completed searches and saved pages are reused, and saved reports publish idempotently without additional model calls. Page snapshots are verified before reuse/publication, and policy is rechecked even on completed-report replay. A changed web page is not silently refetched into an existing task: create a new task to refresh results. Generator stacks are not persisted.

A complete failure of search or page reading throws. A successful empty search returns insufficient evidence. `allowPartial=true` retains available sources and records failures; it does not turn total network failure into a successful empty answer. Budget, revoked permissions, corrupted snapshots, changed requests and ungrounded answers fail explicitly.

See [tool configuration and network boundaries](../../examples/_shared/tools/web-search/README.md) and [Loop API](graph-loops.md).
