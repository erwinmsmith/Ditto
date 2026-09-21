# Type-checked Worker API examples / 可类型检查的 API 示例

These files accompany the bilingual API references. They export example functions and do not execute requests when imported. Supply application-owned model/database/MCP adapters, then call only the example needed. Model calls can consume provider credits; database write/update/delete examples perform the named operation.

这些文件与中英文 API 文档对应。导入不执行请求；参数中的数据库、模型和 MCP 适配器由应用提供。按需调用某个示例函数即可。函数名后的返回值由 TypeScript 推导，完整参数和语义见对应 API 文档。

| File | Reference | Setup |
| --- | --- | --- |
| [memory.ts](memory.ts) | [MEMORY](../memory.zh-CN.md) | Supply MemoryResources; filters/cursors/orderBy belong to the plugin. |
| [infer.ts](infer.ts) | [INFER](../infer.zh-CN.md) · [Providers](../providers.zh-CN.md) | Supply InferClient/ModelConfig, or load root config in setupInfer. |
| [interaction.ts](interaction.ts) | [INTERACTION](../interaction.zh-CN.md) | File examples need workspace access; MCP examples need a connected client and an allowed absolute file path. |
| [retrieval.ts](retrieval.ts) | [RETRIEVAL](../retrieval.zh-CN.md) · [Providers](../retrieval-providers.zh-CN.md) | Supply search/embedding/rerank backends; Memory bridge examples require complete MemoryItem candidates unless mapOutput is supplied. |

Run from the repository root:

```bash
npm run typecheck
```

`tsconfig.json` includes these files; build/test emit configurations keep them out of the distributed package. These are API usage examples, not new SDK implementations or automatic live integration tests. The shared imports and each `// example:` region are reproduced in the corresponding API reference. Keep both copies aligned when changing signatures.

For a complete executable local flow use `npm run example:agent` or `npm run example:tools`. Real MCP setup and commands are in the [live report](../interaction-live-report.md). `.env` loading is explicit: use Node `--env-file=.env` or your application's loader before a function that reads process.env. `loadRuntimeConfigFile` loads YAML and consumes the supplied environment; it does not read `.env` itself.
