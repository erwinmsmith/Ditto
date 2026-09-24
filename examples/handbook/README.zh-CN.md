# 开发者手册示例

[English](README.md) · [开发者手册](../../docs/handbook/index.md)

这些示例验证具体扩展与适配接口，不冒充完整自主 Agent。需要真实模型、Redis、SQLite、跨进程恢复和答案文件时，运行[完整入门 Agent](../package-basics/README.zh-CN.md)。所有导入均使用 npm 公开入口。

| 文件 | 命令 | 验证内容 |
| --- | --- | --- |
| [extensions.ts](extensions.ts) | `node examples/handbook/extensions.ts` | 契约扩展、自定义 Worker、私有 Node、内部 Graph 和副本资源 |
| [skills.ts](skills.ts) | `node examples/handbook/skills.ts` | 实际读取允许的 Skill 文件，用一个 Loop 组合两个 Graph |
| [memory-ranking.ts](memory-ranking.ts) | `node examples/handbook/memory-ranking.ts` | 文件 SQLite 写入与自定义时间排序 Provider |
| [mcp.mjs](mcp.mjs) | `node examples/handbook/mcp.mjs ./workspace hello.txt .` | 真实 MCP SDK 连接、发现、读取文件和观察结果 |

前三个示例只需主包。数据库示例保留 `_shared/tools/storage/sqlite-memory.ts` 与 `sql-memory.ts` 的相对位置。MCP 示例另需在最后一个参数指定的应用目录安装 `@modelcontextprotocol/sdk` 与 `@modelcontextprotocol/server-filesystem`，并先创建 `workspace/hello.txt`。

Memory 算法仅重排有界的关键词候选，不是全库向量检索。Skill 示例展示显式 Context 准备；完整 Agent 仍需按 scope 接入 Redis，并通过数据库 Memory 恢复状态。
