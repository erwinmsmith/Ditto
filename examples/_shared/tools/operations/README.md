# Operation tool adapters

[简体中文](README.zh-CN.md) · [Application tools](../README.md) · [Ten workflows](../../../capabilities/tools/README.md)

Application-owned `RegisteredTool` implementations. Ditto Core provides Graph execution, native model tool requests, registration and observations. These adapters own browser, desktop, SMTP, HTTP, business SQL and code execution. Vendor SDKs and business policy remain outside Core dependencies and its YAML schema.

## Environment

From the repository root with Node.js 24+:

```sh
npm ci
npm ci --prefix examples/_shared/tools/storage/dependencies
npm ci --prefix examples/_shared/tools/operations/dependencies
node examples/_shared/tools/operations/dependencies/node_modules/electron/install.js
examples/_shared/tools/operations/dependencies/node_modules/.bin/playwright install chromium
docker pull node:24-bookworm-slim
```

Start Docker and Redis; configure `DITTO_WORKER_CONTEXT_REDIS_URL` and real model credentials in `.env`. See [configuration](../../../../docs/worker-api/configuration.md). The Electron task requires a graphical session and verifies a visible native window. CI needs a display service; an HTTP request is not a substitute for the desktop task.

The dependency lockfile pins Playwright, Electron, Nodemailer and smtp-server. `sdk.ts` loads SDKs lazily: importing a task does not start services, open windows, send messages or call a model. Consumers install the SDKs and copy application adapters and desktop assets. Core's npm package neither bundles nor automatically loads these tools.

## Files and lifecycle

| File | Responsibility |
| --- | --- |
| [domain.ts](domain.ts) | Tool schemas, controller allowlists, argument and business receipt validation |
| [adapters.ts](adapters.ts) | Bound SQL, constrained HTTP, file I/O, container code, browser/desktop actions, messaging and CRM writes |
| [sdk.ts](sdk.ts) | Lazy application SDK ports |
| [desktop.cjs](desktop.cjs) | Electron main process, constrained save IPC and persistence |
| [desktop-preload.cjs](desktop-preload.cjs) | Isolated bridge exposing only note saving |
| [desktop.html](desktop.html) / [desktop-renderer.js](desktop-renderer.js) | Editable desktop form and Save interaction |
| [fixtures.ts](../../../capabilities/tools/fixtures.ts) | Separate SQLite business state, HTTP/CRM service and SMTP receiver |

`OperationAdapters(directory, request).tools` supplies admitted task tools plus the controller-only `operation_publish` tool. Inject it into `createInteractionWorker` and execute through Runtime. Close Runtime, adapter database, Memory/Redis clients and reference services when finished.

A trusted controller provides `authorized`, task ID, tenant, destination and recipient. The model cannot change them. Validate model arguments before execution and again at the tool boundary. `effects` describes behavior; it does not grant permission.

## Execution boundaries

HTTP tools use the controller's origin, reject redirects, time out after five seconds and bound streamed responses to 64 KiB. Browser requests are restricted to that origin and Service Workers are disabled. File tools use fixed workspace filenames, reject symlink drafts and reject conflicting immutable output.

Generated code runs in Docker with no network or host mounts, a read-only root, a non-root user, dropped capabilities, no privilege escalation, and CPU/memory/process/output limits. Execution times out after twelve seconds. `new Function` parses the body inside the container; Docker is the isolation boundary. There is no host `eval`/`vm` fallback. Trusted deployment configuration can set `DITTO_EXAMPLE_CODE_IMAGE` to a reviewed, pre-pulled Node.js image.

Electron enables context isolation and renderer sandboxing, disables Node integration and external navigation, and exposes only note-save IPC. Screenshots and persisted notes stay within the task directory; the app does not edit existing user documents.

Reference SMTP binds loopback and accepts only `operations@example.test`; it does not connect to Internet mail services. Message-ID deduplication and inbox queries are reference-service features. A replacement needs receiving-side reconciliation or provider idempotency; ordinary SMTP acknowledgments do not guarantee exactly-once delivery across retries.

The CRM reference service accepts HTTP PATCH and commits the update and idempotency result in one database transaction. Recovery queries `/operations/:id` before retrying after an ambiguous connection failure. A real CRM/ERP/ticket integration replaces endpoints, authentication and business checks while preserving the same public Worker composition.

Browser downloads use [Playwright downloads](https://playwright.dev/docs/downloads); desktop control uses [Playwright's Electron API](https://playwright.dev/docs/api/class-electron), which is experimental.

Docker execution and immutable file utilities are shared from [execution](../execution/README.md); copy that directory with the application adapters. Existing adapters.ts exports remain compatible.
