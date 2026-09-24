# Seven control-flow categories: public composition and package acceptance

[简体中文](control-flow.zh-CN.md) · [API index](README.md) · [All control flows](../../examples/control-flow/README.md)

Control flows use a small set of composition primitives: `graph` declares nodes and dependencies, `loop` declares state iteration, `runtime.run` / `runtime.loop` execute them, and Worker factories provide node capabilities. The 38 application examples reuse these primitives without requiring a separate Core API for every business workflow.

## Capability mapping

| Category | Examples | Public composition and execution | Application-owned behavior |
| --- | --- | --- | --- |
| [Sequence and steps](../../examples/control-flow/sequence/README.md) | 4 | Graph dependencies and bindings; staged `runtime.run`; batch `runtime.loop` | Input validation, stage acceptance, batch result shape |
| [Conditions and routing](routing.md) | 6 | Select a Graph from inputs/results; `runtime.run`; dependency joins; tool and output nodes | Routing rules, risk/confidence thresholds, PDF/OCR/ASR tools |
| [Parallelism and aggregation](parallel.md) | 4 | Independent branches, `runtime.run(plan, input, { concurrency })`, dependency joins; `Promise.allSettled` across isolated Runtime calls | Plan constraints, result validation and delivery |
| [Loops and adaptation](iteration.md) | 6 | `loop({ graph, bind, update, done, maxIterations })`, `runtime.loop`, dynamic per-round Graph selection | Goals, budgets, retrieval and revision tools |
| [Failure and recovery](recovery.md) | 8 | `runtime.run` / `runtime.loop`, `AbortSignal`, Context and interaction nodes | Checkpoints, fallback policy, remote idempotency and compensation |
| [Human intervention](human.md) | 5 | Graph and `INTERACTION.OUTPUT` present reviews; reenter `runtime.run`; effects execute through tools | Identity, review requests, version binding, edits and assignment |
| [Task lifecycle](lifecycle.md) | 5 | Graph, `runtime.run`, cancellation and business tools; timer/event adapters invoke public workflows | State storage, ownership, due times, event deduplication and stop requests |

Conditions, application waits and `Promise.allSettled` across Graphs select and compose public execution calls. They do not directly execute Worker handlers. Graph bindings read only declared dependencies. Application code must inspect business failures, model completion and delivery receipts; Graph return alone does not imply business completion.

## Package entries and extension boundaries

| Public entry | Use |
| --- | --- |
| `@codesoul-co/ditto/runtime` | Runtime factory, Graph/Loop composition, public execution types and configuration |
| `@codesoul-co/ditto/contracts` | Context, JSON and external-result contracts |
| `@codesoul-co/ditto/worker/context` | `createContextWorker` |
| `@codesoul-co/ditto/worker/infer` | `createInferWorker`, model configuration and public result types |
| `@codesoul-co/ditto/worker/interaction` | `createInteractionWorker`, `RegisteredTool`, `OutputSink` |
| `@codesoul-co/ditto/worker/node` | Public `WorkerContext` used by an application adapter |

Model calls use `INFER.REASONING.SAMPLE` and configured providers. Business effects use registered `INTERACTION.ACT.TOOL` tools; deliveries use `INTERACTION.OUTPUT` and injected sinks. Examples neither load `src/`, `dist/` or unexported implementation paths nor invoke `WorkerExecutor.execute()` or `WorkerDefinition.instantiate()` themselves.

SQLite, filesystem operations, business HTTP services, parsers and external SDKs in `examples/_shared/tools/` are application extensions. Passing them to `createInteractionWorker({ tools, output })` uses the public extension contract. Human decisions, business updates and event production are trusted controller actions on application state, not Core internals. Test-only Worker wrappers observe actual executions dispatched by Runtime without replacing model or business implementations.

Functions such as `runScheduled` and `runApproval` are exports of the example application, not business methods supplied by Core. Copy those examples and adapters, or compose your own workflows using the same APIs. Core packaging keeps business databases, approval systems and media dependencies outside the framework.

## Release acceptance

```sh
# No model credentials: all public consumer types and package imports
npm run check:examples:control-flow:types

# With .env configured: all seven task suites against installed packages
npm run check:examples:control-flow:package

# Sequence package acceptance on its own
npm run check:examples:sequence:package

# Select task suites; type/import checks still cover all seven categories
npm run check:examples:control-flow:package -- --category human,lifecycle
```

Select a configured real provider with `--provider`. Routing acceptance additionally requires the [file-ingestion dependencies](../../examples/_shared/tools/file-ingestion/README.md); use `--python /path/to/python` or `DITTO_EXAMPLE_TOOLS_PYTHON` for its independent environment. Other categories do not require media dependencies. Missing dependencies are not silently skipped.

The [unified gate](../../scripts/check-control-flow-package.ts):

1. Audits control-flow and shared-tool sources for exported Core entry points, Node built-ins and application-relative imports; rejects direct executor calls.
2. Builds and packs Core and optional retrieval separately, recording Core tarball integrity; allows only compiled `dist/`, package metadata and READMEs in Core.
3. Creates an external consumer, installs both tarballs, Node types and TypeScript, and copies application examples/adapters and task checks without package source, repository tsconfig or `.env`.
4. Typechecks all copied sources with strict consumer settings, without `paths`, `baseUrl` or source symlinks.
5. Imports all 38 examples silently. A runtime module hook blocks modules outside the consumer and permits application entry into Core only through public package specifiers. Negative probes attempt source, internal dist and absolute paths.
6. Runs selected task suites sequentially against that same installation. Node child processes inherit the module guard; provider credentials are passed through environment variables only.

Configured business inputs, outputs and an independent Python environment are application resources, not Core module imports. Scheduled execution requires a running consumer; packaging does not create background schedulers, mail/message adapters or identity services.

The summary is `.examples-control-flow-package-live-results.json`; category reports are `.examples-control-flow-<category>-live-results.json`. They record tarball identity, boundary/type checks, task results and model-call counts. Task artifacts remain under their category's `.examples-<category>-tasks/`. Sequence acceptance checks Context dependencies, stage outputs, batch aggregation and output sinks without requiring an external business database.

The [boundary regression](../../test/control-flow-boundary.test.ts) runs with `npm run check` to prevent source-path imports, unexported entries and direct Worker execution. Package acceptance does not run `npm publish`; the report's `packagePublishEnabled` field records release configuration separately from installation success.
