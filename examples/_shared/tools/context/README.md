# Context task tools

[中文](README.zh-CN.md) · [Examples](../../../capabilities/context/README.md)

`contextTools(directory,request)` returns three public `RegisteredTool` definitions:

- `context_document`: read an admitted initial/revision JSON document, validate release fields and retain its file URI.
- `context_search`: query the admitted HTTP source with size, time and redirect bounds; validate request identity and region.
- `context_publish`: publish a verified report to `artifacts/brief.json` using a temporary file and atomic link; identical content is idempotent, conflicting content is never overwritten.

Register through `createInteractionWorker({tools})` and call through `INTERACTION.ACT.TOOL`. The trusted host supplies directories, tenant identity and URLs. `domain.ts` contains release-specific validation outside Core. Storage configuration reuses the adjacent `storage/` adapters; this directory does not implement another Memory or Context store.
