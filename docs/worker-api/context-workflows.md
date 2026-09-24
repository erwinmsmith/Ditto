# Context workflow APIs

[中文](context-workflows.zh-CN.md) · [Context reference](context.md) · [Runnable examples](../../examples/capabilities/context/README.md)

Loading, selection, assembly, compression and updates compose the existing public `CONTEXT.LOAD / SELECT / UPDATE / COMPRESS` nodes with `INFER.REASONING.SAMPLE`. Assembly combines admitted sources. Semantic summarization is explicit inference followed by validation and an update.

## Application invocation

Save this TypeScript example at the repository root and run `node --env-file=.env your-example.ts` with Node.js 24. For an npm consumer, copy the application storage/context tools and context examples, install the Redis SDK, and configure `ditto.yaml`. Core does not bundle these application adapters or business tools.

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { contextTools } from "./examples/_shared/tools/context/adapters.ts";
import { createFixture } from "./examples/capabilities/context/fixtures.ts";
import { sandbox } from "./examples/capabilities/context/cli.ts";
import { seedConversation } from "./examples/capabilities/context/shared.ts";
import { run } from "./examples/capabilities/context/compress.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure a provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure a model");
await mkdir(".examples-context-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-context-tasks/api-"));
const fixture = await createFixture(directory, "compress");
try {
  const storage = await openAgentStorage(directory, config);
  try {
    const runtime = createDitto({
      config, sandbox: sandbox(config, fixture.request),
      workers: [...storage.workers, createInferWorker(),
        createInteractionWorker({ tools: contextTools(directory, fixture.request) })],
    });
    try {
      await seedConversation(runtime, fixture.request, fixture.turns);
      console.log(await run(runtime, { request: fixture.request, model: { provider, model } }));
    } finally { await runtime.close(); }
  } finally { await storage.close(); }
} finally { await fixture.server.close(); }
```

Entry functions and shared helpers are application code, not additional Core package exports. All Core imports use public package entry points.

## Node contracts

| Capability | Runtime node input | Result and effect |
| --- | --- | --- |
| Initialize/restore | `CONTEXT.LOAD({scope,sources})` | Return `Context`; create or replace the entire Redis working set |
| Read | `CONTEXT.LOAD({scope})` | Return `Context`; absent/expired state throws `CONTEXT_NOT_FOUND` |
| Select | `CONTEXT.SELECT({scope,purpose:"infer",query,limit,maxTokens})` | Return `ContextSelection`; infer with `.context`; no cache write or TTL renewal |
| Assemble | `CONTEXT.UPDATE({scope,add,ingress})` | Preserve sources in `add`; record `sourceNode`, reference and metadata for ingress |
| Update | `CONTEXT.UPDATE({scope,removeIds,add,expectedVersion})` | Duplicate IDs replace by default; return `Context`; stale versions throw `STATE_CONFLICT` |
| Compress | `CONTEXT.COMPRESS({scope,maxItems,maxTokens})` | Prune and save; preserve protected items and whole `callId` groups; impossible budgets throw `BUDGET_UNSATISFIABLE` |
| Summarize | `INFER.REASONING.SAMPLE({model,messages})` → validation → `CONTEXT.UPDATE` | Explicit, verified semantic summary; no hidden inference inside `COMPRESS` |
| Archive/restore | `MEMORY.WRITE` / `MEMORY.GET` | Check `NodeResult.status`, then read `.output` |

Context nodes return raw Context/Selection and throw `ContextError`; do not unwrap `.output`. Tool nodes return `ExternalResult`; inference and Memory return `NodeResult`. Request budgets cannot relax Worker policy. Scoped and explicit-context inputs are mutually exclusive.

Default compression protects protected/safety/currentGoal/pending and system items. Selection can still skip mandatory items under a small budget, so the application checks instructions before inference. Verified summaries preserve original evidence URIs. Full history remains in conversation Memory and the base checkpoint.

## Durable execution order

1. Read admitted files and conversation Memory, execute scoped Context nodes, then archive the base working set.
2. Execute selection, assembly, compression or updates; archive the ready working set and inference view.
3. Read/select Redis again, check equality with the committed view, call the model, validate business fields and citations, then commit the report to Memory.
4. Publish the artifact atomically through an application tool. Identical content is idempotent; conflicting content is not overwritten.

Recovery reads the committed database checkpoint and reconciles Redis. A crash after a cache write but before its checkpoint may repeat that stage. A committed report does not repeat inference. Changed requests require a new task ID. Use one active controller per task; CAS supplies neither a cross-service transaction nor a business task lock. Service failures are never treated as cache misses.

Conversation Memory, task archives and internal knowledge have distinct namespaces. This module reads conversation history. HTTP search is an external source, not a task archive presented as a knowledge base. Third-party and business tools remain under `examples/_shared/tools/context/` outside Core.
