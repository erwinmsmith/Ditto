# RAG application tools

[简体中文](README.zh-CN.md) · [Full workflow](../../../patterns/rag-qa/README.md)

`RagAdapters` registers authorization, ingestion, FTS5 retrieval, snapshot checks and file delivery through public `RegisteredTool` and `RetrievalTargetRegistry` interfaces. Core owns neither these business rules nor SQLite tables. The adapters use Node.js built-ins; Redis uses the adjacent `storage/` application dependencies.

`domain.ts` owns normalized requests, trusted source catalogs, Chinese search tokens, chunks, selection and per-claim citation contracts. `adapters.ts` separately reads user files, the business database and approved records obtained through Memory. Tools run through Runtime `INTERACTION.ACT.TOOL`; the FTS provider runs through `RETRIEVAL.SEARCH`.

The trusted host configures identity, readers and connections, not the model. One adapter binds one request and task directory; the host owns mutual exclusion and file access policies.
