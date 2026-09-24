# Tools and system operations

[简体中文](README.zh-CN.md) · [Capabilities](../README.md) · [API guide](../../../docs/worker-api/tool-workflows.md)

Ten independent entries load context, ask a real model to select a tool and complete arguments through native tool calling, validate application permissions, execute and observe the operation, persist checkpoints, and publish verified output. Register application tools with the public `createInteractionWorker({ tools })` API.

| Capability | Entry / npm command suffix | Operation and verification |
| --- | --- | --- |
| Tool selection | [selection.ts](selection.ts) / `selection` | Choose between order and inventory tools; read order payment status and total |
| Parameter completion | [parameters.ts](parameters.ts) / `parameters` | Fill country, weight and service from Redis context; request an HTTP shipping quote |
| API calls | [api.ts](api.ts) / `api` | Call a separate HTTP service and validate its exchange-rate response |
| Database queries | [database.ts](database.ts) / `database` | Query business SQLite using bound parameters and a tenant predicate |
| File I/O | [files.ts](files.ts) / `files` | Read a draft, append approved text, save and read back `final.txt` |
| Code execution | [code.ts](code.ts) / `code` | Run model-generated JavaScript in Docker Node.js and verify the calculation |
| Browser operations | [browser.ts](browser.ts) / `browser` | Fill an order form in Chromium, click search/download, verify CSV and save a screenshot |
| Desktop operations | [desktop.ts](desktop.ts) / `desktop` | Fill a visible native Electron window, click Save, read the persisted note and capture a screenshot |
| Messaging | [message.ts](message.ts) / `message` | Send SMTP mail and verify the recipient, subject and body in the receiving test inbox |
| System writes | [system-write.ts](system-write.ts) / `system-write` | PATCH a CRM ticket and verify the business version and idempotency record |

## Setup and execution

Use Node.js 24+, a configured real model and Redis. Follow [application tool setup](../../_shared/tools/operations/README.md) to install the Redis client, browser, Electron, mail SDKs and Docker environment. Model connections use root `ditto.yaml` / `.env`; Redis uses `DITTO_WORKER_CONTEXT_REDIS_URL`.

```sh
npm run example:tools:selection
npm run example:tools:parameters
npm run example:tools:api
npm run example:tools:database
npm run example:tools:files
npm run example:tools:code
npm run example:tools:browser
npm run example:tools:desktop
npm run example:tools:message
npm run example:tools:system-write
```

Each invocation creates a separate `.examples-operations-tasks/cli-*` directory and prints its path and result. Every task publishes `artifacts/operation.json`, containing the operation ID, tool, value, evidence, validated plan and `verified: true`. File, browser and desktop tasks retain additional output and screenshots. Generated directories are ignored by Git.

Save a model plan and resume using the directory printed by the first command:

```sh
npm run example:tools:browser -- --checkpoint
npm run example:tools:browser -- --directory .examples-operations-tasks/cli-XXXXXX
```

`--provider <name>` selects a configured model provider. On resume, the HTTP/SMTP reference services bind their original ports; a port conflict fails explicitly. A task ID identifies immutable input; changed input requires a new task.

## Storage and recovery

- Context uses real Redis, scoped by tenant and task ID. Expired context is rebuilt from database Memory input, plan and receipt. Redis failures do not trigger an in-process fallback.
- Public `MEMORY.GET/WRITE` persist four stages in a separate `memory.sqlite`. Other adapters can implement the public MemoryStore interface; this module's database acceptance target is SQLite.
- A separate `business.sqlite` stores orders, inventory, tickets, received mail and idempotency records. It does not replace Memory Worker.

Plans are committed before tool execution; receipts follow business validation. A saved receipt prevents additional model calls and repeated business work. Publication can be retried. Mail and CRM recovery reconcile receiving-system records when an effect occurred before a Memory receipt was saved. The reference inbox deduplicates Message-ID; CRM records the key and update atomically. Generic SMTP does not guarantee those semantics: a production integration must supply equivalent reconciliation and deduplication.

## End-to-end acceptance

```sh
npm run check
npm run check:examples:tools:tasks
npm run check:examples:tools:tasks:package
```

The task suite covers ten successful workflows, ten Redis expiry recoveries, Redis/Memory/business database/API/SMTP outages, rejected tools/parameters/authorization, path and symlink rejection, code failure, publication retry, cancellation, and process termination at plan/result checkpoints. Mail, CRM and desktop tasks also receive `SIGKILL` after the real effect but before the Memory receipt; a new process resumes them. Tests read business data and output files rather than trusting a model success claim.

Separate Docker checks verify timeout, exclusion of host model credentials and container cleanup. Package acceptance installs an npm tarball outside the repository, checks strict types without paths aliases, enforces runtime import boundaries, silently imports all ten entries, then runs the whole task suite. Missing services or real-model access fail the run instead of skipping a capability.

Targets are the supplied HTTP/CRM reference service, SMTP test inbox, real Chromium and a separate Electron desktop application. Mail goes only to the local `operations@example.test` inbox. Integrating a company CRM, production mailbox or another desktop application requires replacing application adapters and validating those specific targets.

## Graph / Loop composition

`shared.ts` exports the full-task `run*Loop`. The `run*()` entry invokes `runtime.loop()` once; its plan yields stage Graphs for Loop-owned scheduling. Reusable subplans share a 1024-Graph execution budget, including recovery and repetitions. Graphs retain node dependencies; all source, model and business effects use public Workers. See [Graph / Loop API](../../../docs/worker-api/graph-loops.md).
