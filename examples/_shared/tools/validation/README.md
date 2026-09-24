# Validation and safety tools

`domain.ts` owns ingress schema, redaction, explicit requirements, numeric conflicts, evidence checks and authorization/risk rules. `tools.ts` provides the `validation_source` and `validation_commit` RegisteredTools plus trusted controller methods. `fixtures.ts` creates synthetic release documents and a separate business database; it does not contact real users or publishing platforms.

Raw sources are read and sanitized inside the adapter. Commit revalidates input and assessment, reads current policy and verifies approval inside the same SQLite write transaction as publication. Immutable report delivery reuses `execution/files.ts`; retries reconcile committed effects using an idempotency record. Context/Memory lifecycles reuse `storage/`.

These are application integrations, not Core dependencies. Replace detectors, host authentication and business storage as needed while preserving server-side enforcement at the write boundary. See [API contracts and detection limits](../../../../docs/worker-api/validation-workflows.md). Tool approval metadata is descriptive and the sample controller identity string is not an authentication credential.
