# Handoff application tools

These tools implement the device-ticket protocol through public `RegisteredTool` registration with Interaction Worker. Domain rules, SQLite and report files remain application concerns outside Core.

| Tool              | Arguments                             | Behavior                                                                                                                   |
| ----------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `handoff_ticket`  | `{}`                                  | Validate request, sources and history; return authoritative ownership and pending packet                                   |
| `handoff_read`    | `{agent,version}`                     | Load current owner's scoped evidence and parent handoff; reject old owners, premature receivers and handling while pending |
| `handoff_decide`  | `{agent,version,decision}`            | Validate source/role rules and persist proposal or outcome; replacement request and completion commit in one transaction   |
| `handoff_accept`  | `{agent,version,packetId,acceptance}` | Atomically transfer responsibility after acknowledgement; identical replay is idempotent, conflicting replay fails         |
| `handoff_publish` | `{report}`                            | Match database state, then write immutable JSON/Markdown reports                                                           |

Invalid decisions/acknowledgements return `INVALID_DECISION` / `INVALID_ACCEPTANCE` for bounded Loop retries. Storage, permission, version and packet-digest errors propagate. Every tool checks enabled/principals in `policy.json`. A trusted controller supplies role identifiers; these are not independent multi-tenant service credentials.

`domain.ts` defines routes, validation and hashes. `adapters.ts` implements fixed tools and database transactions. `createDemo` creates `request.json/sources.json/policy.json/tickets.sqlite`; resume the existing directory. Models see projected evidence without the customer email. Replacement records are local requests, not messages, shipments or refunds.

[Complete contracts and integration boundaries](../../../../docs/worker-api/handoff-workflows.md)
