# Developer handbook examples

[中文](README.zh-CN.md) · [Handbook](../../docs/handbook/index.md)

These small executable examples demonstrate extension and integration boundaries. They use public npm entries and are not complete autonomous Agent tasks. For a real-model Agent with Redis, SQLite, process recovery and output files, use [package basics](../package-basics/README.md).

| File | Run | What it verifies |
| --- | --- | --- |
| [extensions.ts](extensions.ts) | `node examples/handbook/extensions.ts` | Contract augmentation, custom Worker, private Node, internal Graph and resource isolation |
| [skills.ts](skills.ts) | `node examples/handbook/skills.ts` | Actual allowed Skill file read and two Graphs composed by one Loop |
| [memory-ranking.ts](memory-ranking.ts) | `node examples/handbook/memory-ranking.ts` | File SQLite writes and an injected recency ranking provider |
| [mcp.mjs](mcp.mjs) | `node examples/handbook/mcp.mjs ./workspace hello.txt .` | Real MCP SDK connection, discovery, file read and observation |

Install `@codesoul-co/ditto` for the first three. Keep the SQL adapter files at their original relative paths. The MCP example additionally needs `@modelcontextprotocol/sdk` and `@modelcontextprotocol/server-filesystem` in the application directory passed as the last argument. Create `workspace/hello.txt` before running it.

The Memory algorithm only reranks a bounded keyword candidate set. It does not implement full-corpus vector retrieval. Skill loading is an explicit Context preparation example; a full Agent should use Redis-backed scoped Context and persistent Memory.
