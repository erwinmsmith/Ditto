# Retrieval tools and third-party configuration

[简体中文](README.zh-CN.md) · [Eight retrieval examples](../../../capabilities/retrieval/README.md)

This directory belongs to the application. Install the isolated HTML decoder dependency:

```sh
npm ci --prefix examples/_shared/tools/retrieval/dependencies
```

- `memory.ts`: explicitly ingest approved internal knowledge through `MEMORY.WRITE`, separately from task archives.
- `domain.ts`: request, query, evidence, citation and report contracts.
- `adapters.ts`: document and SQLite FTS5 Providers, page-reading and local report tools.
- `web.ts`: Wikipedia search Provider, HTTPS transport and LinkeDOM body extraction; scripts are never executed.
- `dependencies/`: application SDK manifest and lockfile. Consumers may instead install `linkedom` at their project root.

`RetrievalAdapters(directory, request)` opens an existing `knowledge.sqlite` only when external knowledge is selected with `articles USING fts5(tenant UNINDEXED, title, body)`. The trusted request tenant must match each `target.namespace`; SQL values are bound, and the model cannot choose tenants or tables. Register `adapters.providers` with `createRetrievalWorker` and `adapters.tools` with `createInteractionWorker`, then close the adapter in `finally`.

Trusted `allowedOrigins` configure webpage access. `searchEngine: "wikipedia"` uses English Wikipedia full-text search; `"brave"` uses Core's public `createBraveWebSearchProvider` and `DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY`. Missing Brave credentials fail explicitly. Page tools check both the origin allowlist and Runtime sandbox, reject redirects and own their HTTP/SDK lifecycle.

External knowledge stays separate from Memory: `knowledge.sqlite` supplies external records; `memory.sqlite` stores internal knowledge and task checkpoints through the Memory Worker. Knowledge keys are `knowledge:<tenant>:<key>`; checkpoints are `retrieval:<requestId>:<stage>`. Internal searches filter by permitted knowledge keys and validate kind and tenant. Internal mode never opens the external database. See [storage](../storage/README.md) for Redis Context and database Memory initialization. Only trusted controllers should be able to modify the application directory and source files.

Protocol references: [MediaWiki Search API](https://www.mediawiki.org/wiki/API:Search), [SQLite FTS5](https://www.sqlite.org/fts5.html).
