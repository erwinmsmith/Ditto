# Tools: definition, selection, execution and observation

An ordinary tool is an application-supplied `RegisteredTool`. It can wrap database SDKs, CRM APIs, files or browsers. Ditto routes calls through `INTERACTION.ACT.TOOL`, checks permissions for the registered name, validates results and turns them into usable information through OBSERVE.

## 1. First execution

This example only needs the main package and counts Unicode characters:

```sh
node examples/package-basics/tools.ts 'A😀'
```

The expected count is 2. Copy the complete module into your application:

<<< ../../examples/package-basics/tools.ts

A Tool is not a new Node type. Ordinary tools share `INTERACTION.ACT.TOOL` and select an implementation by `name`. Adding a CRM tool usually does not require a framework change or a `CRM.UPDATE` node.

## 2. Three parts of a tool

| Part | Responsibility |
| --- | --- |
| name / description / inputSchema | Explain purpose and arguments to callers and models |
| validate(arguments) | Perform runtime validation; JSON Schema alone does not replace this |
| execute(arguments,context) | Perform the operation and return ToolExecutionOutcome |

Arguments are JSON objects. Do not return functions, Date, BigInt, connections or raw Error instances. Convert dates to ISO strings and represent binary/large files using authorized references.

Successful tools return at least one of `content`, `structuredContent` or `references`. Failures can return safe structured errors. The Registry binds callId and source to the original request. Distinguish failure, cancellation, timeout and unknown outcomes.

## 3. Registration and permission are separate

```ts
const runtime = createDitto({
  sandbox: { tools: ["lookup_order"] },
  workers: [createInteractionWorker({ tools: [lookupOrder] })],
});
```

`lookupOrder` is an application-defined RegisteredTool. Registration does not grant permission, and an allowed name does not create a tool. ToolRegistry.list only exposes tools permitted in the execution context.

`requiresApproval` and `effects` are descriptive metadata; they do not open an approval UI. A trusted application controller checks approval records and makes approval an execution prerequisite. Model-generated claims of approval are not authorization.

## 4. Build a tool-chain Graph

```text
input → lookup_customer → OBSERVE ─┐
input → lookup_order → OBSERVE ────┴→ analyze status
                                           ↓
                                permissions / idempotency
                                           ↓
                                      update_crm
                                           ↓
                                    OBSERVE → OUTPUT
```

Independent reads may run concurrently. Writes depend on validation. Check ExternalResult.status before proceeding. See [serial, parallel and conditional tool chains](../../examples/patterns/tool-chain/README.md).

Models or application logic can fill arguments from context, but tools still validate schemas and business rules. Do not execute arbitrary model-generated shell strings. Use allowed commands, argument arrays and a constrained executor.

## 5. Close the model-action loop

[Tool selection](../../examples/capabilities/tools/selection.ts) chooses from permitted tools; [argument completion](../../examples/capabilities/tools/parameters.ts) constructs a business API request from actual context. Both use Redis Context, database Memory and real service responses.

For each model action, check that the name was advertised for the current round. For writes, also check identity, object state and idempotency. OBSERVE retains callId, source and status; explicitly UPDATE working context afterward.

OBSERVE does not retry or update Context automatically. Deciding to retain a failed observation for another reasoning round belongs to the application. Never relabel failed outcomes as success.

## 6. Files, commands and networks

- File tools can use `ctx.services.sandbox.readText/writeText` within the configured workspace and read/write/path policy.
- Command tools need an explicit SandboxExecutor. `createLocalSandboxExecutor` starts local processes; untrusted code needs container or OS isolation.
- HTTP tools should restrict destinations, response size and timeouts, validate status and business fields, and forward `ctx.signal`.
- Direct third-party SDK calls do not automatically inherit Sandbox network rules; adapters must enforce them.

Sandbox is a cooperative capability boundary, not an OS sandbox for arbitrary JavaScript. See [Runtime/Sandbox](../worker-api/runtime.md).

## 7. Retry and deliver

A client timeout does not prove the server did not commit. Use stable idempotency keys for writes and reconcile external state before retrying. An OutputSink's accepted receipt means it accepted the request, not that an email was read or a remote task completed. Add confirmation steps where required.

[INTERACTION API](../worker-api/interaction.md) · [System operations](../../examples/capabilities/tools/README.md) · [Recovery](reliability.en.md)
