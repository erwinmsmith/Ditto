# Application tools and third-party adapters

[简体中文](README.zh-CN.md) · [Shared resources](../README.md)

Keep example business tools, third-party SDK adapters and registration configuration here. Core provides public contracts such as `RegisteredTool`, `ToolRegistry` and `createInteractionWorker`. Business rules, vendor dependencies, credentials and client lifecycles belong to the application, outside `src/` and Core runtime dependencies.

[pickup-ledger.ts](pickup-ledger.ts) exports `createPickupTool(ledger)` for [risk routing](../../control-flow/routing/risk.ts). The `record_pickup` tool accepts `{ id, code, quantity }`, writes to the supplied Map and returns a successful `ExternalResult` outcome with `structuredContent`. Matching request IDs and content are idempotent; conflicting content fails. The ledger is not durable. `effects: ["write"]` describes effects and does not grant authorization.

Register explicitly, retaining configured network permissions:

```ts
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { createPickupTool, type PickupRecord } from "./pickup-ledger.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const ledger = new Map<string, PickupRecord>();
const tools = [createPickupTool(ledger)];
const runtime = createDitto({
  config,
  sandbox: { ...config.sandbox, tools: tools.map(tool => tool.name) },
  workers: [createInteractionWorker({ tools })],
});
try {
  const result = await runtime.invoke("INTERACTION.ACT.TOOL", {
    call: { id: "request-731", name: "record_pickup", arguments: { id: "request-731", code: "PICKUP-731", quantity: 3 } },
  });
  if (result.status !== "success") throw new Error("Pickup registration failed");
} finally { await runtime.close(); }
```

Install PDF/OCR/ASR, database or vendor SDKs in the consuming application and inject configuration and clients into adapters. Validate original file bytes before supplying `ParsedFile`; extension/MIME checks do not establish file authenticity. [File ingestion tools](file-ingestion/README.md) provide actual PDF/spreadsheet/OCR/ASR implementations and configuration; task acceptance covers them from original files. The creating application closes SDK clients. Do not add vendor switches or example business configuration to the Core YAML schema or introduce implicit string-based plugin loading.

[pickup-task-store.ts](pickup-task-store.ts) is an application-side SQLite task, review, ledger and artifact adapter for full task acceptance, outside Ditto Core.

[order-files.ts](order-files.ts) provides order reading/persistence, plan persistence, report aggregation and delivery using Node.js standard libraries. See [parallel API usage](../../../docs/worker-api/parallel.md).

[brief-files.ts](brief-files.ts) supplies structured-source lookup, evidence checks, draft revisions, round records and document generation using Node.js standard libraries. Rules, directories and budgets belong to the application; see [loop API usage](../../../docs/worker-api/iteration.md).

[recovery-store.ts](recovery-store.ts) persists application checkpoints, public Context, approvals and events, and calls HTTP business tools. [fulfillment-service.ts](fulfillment-service.ts) is a local inventory/reservation/shipment reference service with its own SQLite ledger. Both use Node.js standard libraries. Fault settings, idempotency and compensation belong to the application; see [recovery API usage](../../../docs/worker-api/recovery.md).

[human-review-store.ts](human-review-store.ts) provides application-owned SQLite reviews, immutable artifact versions, human decisions, a file inbox and gated local effect tools. Approval, editing and assignment are trusted controller methods, not model tools. See [human intervention API usage](../../../docs/worker-api/human.md).

[lifecycle-store.ts](lifecycle-store.ts) provides application-owned task state/history, transactional claims, business revision guards, call budgets, persisted triggers and notice registration. Timer consumers and file-event adapters compose public APIs; business updates and operator stops belong to a trusted controller. See [lifecycle API usage](../../../docs/worker-api/lifecycle.md).

[understanding-store.ts](understanding-store.ts) provides application parameter validation, input journals and Memory archive pointers, clarification and selection records, report registration, and file delivery. Trusted controllers accept user replies and selections; these methods are not model tools. See [understanding and interaction APIs](../../../docs/worker-api/understanding.md).

[Context / Memory storage](storage/README.md): Agent examples use Redis Context and database Memory, with separate business state. Subsequent examples follow the same storage and end-to-end verification contract.

[planning-domain.ts](planning-domain.ts) and [planning-store.ts](planning-store.ts) provide the planning catalog, dependency/budget validation, resource scheduling, task ledger, and actual sales/inventory tools. See [planning APIs](../../../docs/worker-api/planning.md).

[retrieval/](retrieval/README.md) provides document and SQLite FTS5 Providers, Wikipedia search, HTML extraction and snapshot/report tools. SDK dependencies stay in the application.

[analysis/](analysis/README.md) provides material normalization, approved-reference verification, unit conversion, deduplication, comparisons and report tools, reusing the existing parser and storage adapters.

Context source and publication adapters live in [context](context/README.md); they remain application-owned.

Memory task tools and database wiring: [memory](memory/README.md).

[Operation tools](operations/README.md) provide HTTP, business SQL, files, isolated code, Chromium, native Electron, SMTP and CRM adapters for ten public-API workflows.

[Observation tools](observation/README.md) provide actual HTTP result reading, structured error mapping, evidence validation, task-state transactions and report publication.

[Content tools](content/README.md) provide pinned text snapshots, transformation validation, exact citations and Markdown/JSON/HTML renderers.

[Multimodal tools](multimodal/README.md) provide DOCX parsing, image validation, video frame extraction and media evidence delivery, reusing PDF/ASR tools.

[Data/code tools](data-and-code/README.md) provide authorized SQL, programs, statistics/charts, source search and protected tests; [shared execution utilities](execution/README.md) are reused by data and operations examples.

[Validation tools](validation/README.md) provide source sanitization, rule/evidence checks, transactional publication and trusted approval binding.

[RAG tools](rag/README.md): authorized ingestion, Chinese full-text search, source snapshots, per-claim citations and answer delivery.

[Research tools](research/README.md): trusted research policies, reusable web adapters and verified report publication.

[ReAct tools](react/README.md): scoped job operations, runbook search, Chromium result retrieval and idempotent recovery.
