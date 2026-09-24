# Product-copy catalog and verification tools

Application `RegisteredTool` adapters for the [multiple-candidate example](../../../patterns/candidate-selection/README.md). `createTask` accepts a trusted request and product catalog and binds them by hashes; `createDemo` supplies fixture inputs. `CandidateAdapters` registers loading, candidate persistence, grade evidence and publication. Imports perform no work.

Tools check exact CTA, fact phrases and IDs, length limits and artifact hashes. Selection ranks qualified scores. Fusion copies approved fields, preserves parent identity and undergoes a fresh evaluation. Scores remain model judgments and cannot override hard checks.

Replace catalog loaders, contracts and verifiers in the application layer for other candidate tasks. Keep business dependencies outside Core. Outputs are real local JSON/Markdown files; no external messages or publications occur. See the [complete contracts](../../../../docs/worker-api/candidate-workflows.md).
