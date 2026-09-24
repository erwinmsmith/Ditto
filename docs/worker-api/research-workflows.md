# Deep research workflows

A complete research agent is one `runtime.loop(runResearchLoop, [input, options])`. Its generator yields flat stage Graphs with `graphStep`. The Loop owns decomposition, repeated search/read/assessment, stopping and synthesis; Graph nodes invoke public Context, Memory, Infer and Interaction Workers. No nested runtime or direct Worker execution is needed.

The following consumer example runs a real research task. Copy `examples/patterns/deep-research` and its application tools (`research`, `web-search`, `storage`, `evidence.ts`, `execution/files.ts`, `retrieval/web.ts`, `retrieval/domain.ts` and `retrieval/dependencies/package.json`) into the consumer project. Install `@ditto/core`, `redis` and `linkedom`, configure `ditto.yaml` and environment variables, then run with Node 24+.

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createTask } from "./examples/_shared/tools/research/adapters.ts";
import { searchConfig } from "./examples/_shared/tools/web-search/providers.ts";
import { defaultRequest } from "./examples/patterns/deep-research/fixtures.ts";
import { openResearch } from "./examples/patterns/deep-research/cli.ts";
import { runResearch } from "./examples/patterns/deep-research/index.ts";
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider =
  process.env.EXAMPLE_RESEARCH_PROVIDER ?? config.model?.provider;
if (!provider || !config.providers[provider])
  throw new Error("Configure provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure model");
await mkdir(".examples-research-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-research-tasks/client-"));
const search = searchConfig();
const request = await createTask(directory, defaultRequest(), search);
const app = await openResearch(directory, request, config, search);
try {
  const result = await runResearch(app.runtime, {
    request,
    model: { provider, model },
  });
  console.log(JSON.stringify(result));
} finally {
  await app.close();
}
```

## Contracts and execution

`Request` contains authenticated `tenant/principal`, immutable task `id`, `question`, `researchType` (`market`, `industry`, `academic`, `competitive`, `policy`), `audience`, `scope`, allowed source origins, reference URLs and explicit budgets. These research types describe the same evidence-driven workflow; they do not claim specialized market data, academic database or legal expertise. Authentication and policy issuance belong to the trusted application controller.

The model creates up to three subquestions. Each round searches new queries, reads actual HTML, selects source excerpts and emits a coverage matrix (`covered`, `gap`, `conflict`) plus next queries. The next round follows those discoveries. The agent stops on complete coverage, repeated evidence/no new queries, deadline or round/search/page/model limits. The final synthesis uses exact source quotations, then a separate model pass checks entailment and coverage. One repair attempt is allowed. Unresolved contradictions preserve both sides; missing answers remain explicit.

`maxQueries` (1–3) and `maxPages` (1–6) cap one round; `maxRounds` (1–4), `maxSearches` (1–12), `maxReadPages` (1–16), `maxModelCalls` (8–24) cap the task. `researchSeconds` (1–3600) bounds scheduling new research work from the persisted start time, including pauses; it is not a whole-task wall-clock timeout. In-flight requests have transport timeouts and synthesis may finish afterward. Use `signal` for immediate enclosing cancellation. Four model calls are reserved for synthesis/verification/repair before starting another assessment round. Reserved dispatch attempts are charged before execution; a crash may conservatively overcount. Provider retries happen inside one search/read dispatch and do not represent separate budget units. These limits bound calls, not monetary cost.

Context is in Redis under a task scope; database Memory stores request fingerprints, usage, model outputs, frozen round schedules, results and reports. Cache expiry rebuilds from Memory. Storage failure is surfaced; it never selects an in-memory fallback. Local files contain permission policy, immutable raw page snapshots/search caches and output artifacts. These files are not a substitute for Memory. By default Memory uses file SQLite; a different database is supplied through the public MemoryStore adapter contract.

`runResearch(runtime, input, { stopAfter: "plan" | "round" | "report", signal })` returns a checkpoint or `Report`. Resume with the same trusted request and task directory. A completed report is reauthorized, citations are checked against stored HTML, and publication is replayed without new model/network work. Changed requirements need a new task ID/directory. Use one active runner per task directory; distributed concurrent execution requires application locking.

## Tool and source boundary

`ResearchAdapters` reuses `WebAdapters` network reading/search/snapshot tools, replaces its QA authorization/publication with research-specific tools and verifies both policies. All dispatch uses `INTERACTION.ACT.TOOL`; tool methods are never called from the Loop. `research_publish` writes `output/report.md` and `output/report.json` idempotently. Publication failure can retry from the saved verified report.

The default MediaWiki provider searches the configured wiki, not the entire Internet. Brave supports general web search with a configured key. Explicit reference URLs supplement search but must also be downloaded. HTML extraction supports readable paragraphs; PDF, authenticated pages, JavaScript rendering and academic paywalls require separate application tools. Search snippets are discovery data, never citation evidence. The evidence pool is capped at 48,000 serialized characters and final selection at eight excerpts; omitted sources and unresolved scope are disclosed. Large studies should be split into bounded tasks by the application.

Every citation records its URL, extraction paragraph, fetch time and HTML SHA256; paragraph numbers are extracted-text locations, not original HTML line numbers. Fetch time is not publication time. `crossCheck` requires distinct origins and different text per answered claim, plus model grounding; it does not prove publisher independence or source truth. Source conflicts and single-source claims remain visible. Untrusted page instructions cannot grant tools or alter budgets/origin policy. HTTPS, pinned DNS, redirect checks, body/time caps and source policies are shared with [Web search workflows](./web-search-workflows.md).

## Verification

`check:examples:research:package` installs the actual tarball outside the repository, strictly type-checks without aliases, guards runtime imports, checks silent module imports, executes this documentation example and the task suite. The suite separates live Internet experiments from a controlled HTTP corpus; both use real model inference, Redis and SQLite. The controlled corpus requires discovering an annex name from one page before a later query can retrieve the missing fact. It also exercises conflicts, hostile text, budget stops, unavailable services, cache expiry, process termination and publication recovery. See the example README for commands.
