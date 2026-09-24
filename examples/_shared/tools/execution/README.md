# Shared application execution utilities

`docker.ts` provides `isolatedCode` for JSON function bodies and `isolatedTests` for controller-owned Node test files. Both delegate to `isolatedNode`, whose harness is trusted application code. Generated programs are passed over stdin and execute only inside the configured Docker container. Do not expose arbitrary harness selection as a model tool.

`files.ts` writes immutable files atomically via a temporary file and hard link, verifies equal existing content, and rejects conflicting files. These utilities belong to application adapters, not Ditto Core. The operations adapter re-exports its existing utility names for compatibility.

See [data/code configuration](../data-and-code/README.md) for resource limits, image setup and test boundaries.
