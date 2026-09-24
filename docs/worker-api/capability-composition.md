# Public API composition for Agent capabilities

Twelve categories and 86 runnable examples share public Worker and Runtime APIs. Graphs, model instructions, tools and storage adapters express application capabilities; the Core execution contract does not require a new node for every business concept.

## Capability mapping

Every category uses `CONTEXT.LOAD`, `MEMORY.GET/WRITE`, `INFER.REASONING.SAMPLE` and `INTERACTION.ACT.TOOL`, composed through a single `runtime.loop(run*Loop, input)` execution. Each plan yields its stage Graphs with `yield* graphStep(graph, input, options)`.

| Category | Entries | Composition and extension points |
| --- | ---: | --- |
| [Understanding and interaction](../../examples/capabilities/understanding/README.md) | 6 | Model extraction of goals, constraints and intent; controller-owned replies/options; `CONTEXT.UPDATE`, `INTERACTION.OUTPUT` |
| [Planning](../../examples/capabilities/planning/README.md) | 5 | Model decomposition and dependency/tool proposals; application budget/resource validation; `CONTEXT.UPDATE`, `INTERACTION.OUTPUT` |
| [Retrieval](../../examples/capabilities/retrieval/README.md) | 8 | Query rewriting/expansion, source retrieval and citations; `RETRIEVAL.SEARCH`, `MEMORY.SEARCH`; internal Memory and external knowledge remain distinct |
| [Information analysis](../../examples/capabilities/analysis/README.md) | 7 | Aggregate, extract, deduplicate, compare and verify against sources; retrieval providers, Memory search, Context update |
| [Context](../../examples/capabilities/context/README.md) | 5 | Scoped loading/assembly; `CONTEXT.SELECT/COMPRESS/UPDATE`; model-generated summaries combined with bounded Context operations |
| [Memory](../../examples/capabilities/memory/README.md) | 4 | Durable recall, approved writes, revision and progress recovery; `MEMORY.SEARCH/UPDATE`, MemoryStore, SQLite/PostgreSQL/Qdrant and embedding adapters |
| [Tools and systems](../../examples/capabilities/tools/README.md) | 10 | Select allowed tools and fill arguments; real service/database/file/container/browser/desktop/message operations; `RegisteredTool`, Sandbox and `INTERACTION.OBSERVE` |
| [Execution understanding](../../examples/capabilities/observation/README.md) | 5 | Read real outputs, normalize failures, update state and decide next actions; `INTERACTION.OBSERVE`, `CONTEXT.UPDATE` |
| [Content](../../examples/capabilities/content/README.md) | 7 | Generate, rewrite, summarize, expand, translate, convert and cite; evidence validators and artifact renderers |
| [Documents and multimodal](../../examples/capabilities/multimodal/README.md) | 8 | PDF/Word parsing, speech transcription and video frames; text/vision inference and independent media tools |
| [Data and code](../../examples/capabilities/data-and-code/README.md) | 12 | Propose queries/programs/patches; execute SQL, calculations, charts and protected tests; validate actual outputs |
| [Validation and safety](../../examples/capabilities/validation/README.md) | 9 | Evidence-based quality evaluation; trusted permission/policy/risk enforcement and redaction before inference or persistence |

Model output alone does not establish completion. Tasks validate structures and evidence, use actual tool results, persist checkpoints and verify deliverables. Authorization, human approval, budgets, idempotency and isolation are application-enforced constraints.

## Execution and extension boundaries

The call chain is application entry → `createDitto({ workers, config, sandbox })` → `runtime.loop(Loop)` → `graphStep(Graph)` → registered Worker → application adapter. Graph `.node(id, publicNodeName, dependencies, mapper)` defines operations and dependencies.

Public imports include:

- `@ditto/core/runtime`: runtime creation, graph/loop composition and configuration.
- `@ditto/core/worker/context`: Context Worker, Redis store contract, scopes and errors.
- `@ditto/core/worker/memory`: Memory Worker and persistent store contracts.
- `@ditto/core/worker/infer`: inference Worker, model and message types.
- `@ditto/core/worker/interaction`: tools, observations and output adapters.
- `@ditto/core/worker/retrieval` and explicitly exported adapter subpaths: retrieval providers, Memory/Context wiring and embeddings.
- `@ditto/core/contracts`: shared JSON and result contracts.

Vendor HTTP/SDK calls, PDF/OCR/ASR, browsers and code runners live under `examples/_shared/tools` and are registered through public extension interfaces. Those calls implement adapters. CLI fixture creation, trusted human replies and connection lifecycle are host responsibilities.

Test harness Worker wrappers observe real execution, inject faults and simulate process termination. They are separate from application orchestration. Application directories forbid direct `.instantiate()` / `.execute()` calls and private Core imports.

## npm consumption

The `@ditto/core` tarball contains public implementation and declarations under `dist`, accessed through `package.json.exports`. Core `src`, examples, business tools, local credentials and test artifacts are excluded.

Install Core, copy the desired example and relative application dependencies, install the relevant `examples/_shared/tools/*/dependencies/package.json` dependencies, and configure real services. Functions such as `run`, `runGoal` and `runPlan` belong to the example application. They are not 86 additional Core package exports. Each category links runnable integration instructions.

Release checks build before `npm pack --ignore-scripts`. The repository's `private: true` still prevents actual `npm publish`; compatibility checks neither change that flag nor publish a package.

## Unified release gate

```sh
# One tarball, strict public types, 86 silent imports and negative boundary probes
npm run check:examples:capabilities:types

# One complete task per capability; Memory covers all three backends by default
npm run check:examples:capabilities:package

# Every existing scenario, including faults, expiry, cancellation and recovery
npm run check:examples:capabilities:full

# Select task categories; static/type/import checks still cover every entry
npm run check:examples:capabilities:package -- --category context,memory --memory-backend sqlite
```

Live tasks require a text model and Redis. All-backend Memory additionally needs PostgreSQL, Qdrant and real embeddings. Multimodal tasks need a vision model and media Python environment; tools/code need Docker, browser and Electron runtimes. See category READMEs and `.env.example`. Unavailable dependencies fail instead of being skipped or replaced with in-process stores.

The gate installs Core exactly once in an external consumer, without TypeScript path aliases, Core sources or a copied `.env`. The runtime resolver rejects private package paths and repository modules. Reports include the node matrix, tarball integrity, import counts and per-category task results.

`--coverage capabilities` selects the first complete task for every mode while retaining its original delivery assertions. `--coverage complete` runs all scenarios. Neither selection replaces real dependencies or weakens assertions. Individual category package gates retain complete coverage by default. Type/import checks and actual task results are reported separately.

Ignored summary: `.examples-capabilities-package-live-results.json`. Artifacts and category reports: `.examples-capabilities-tasks/`. SQLite results do not establish another backend's behavior, and a selected-category run does not establish all-category task acceptance.

Per-capability tasks invoke each example’s exported entry function, validating the complete entry-to-artifact path in addition to silent imports.

[Graph composition through Loop](graph-loops.md)
