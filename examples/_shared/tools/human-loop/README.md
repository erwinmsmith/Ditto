# Human review application adapter

`ReviewApplication` reuses [HumanReviewStore](../human-review-store.ts) for versioned drafts, atomic approvals, durable review delivery and publication reconciliation. It adds request/source binding, fresh permission checks, approved-version continuation validation and actual publication verification for [Human-in-the-loop](../../../patterns/human-in-the-loop/README.md).

`createDemo` initializes a dedicated directory. `ReviewApplication.open` opens the review database; close it after Runtime/storage. `decide`, `edit` and `claim` belong only to the authenticated application controller and are absent from `tools`. Supply `tools` and `output` to `createInteractionWorker`. Keep model credentials and production identities outside model-controlled arguments.

The local policy allows `example-publisher` to review publication and `example-triager` to claim a handoff. It is an application fixture, not authentication. Actual publication writes local files; external services require their own authorization and atomic idempotency contracts. See the [API guide](../../../../docs/worker-api/human-loop-workflows.md).
