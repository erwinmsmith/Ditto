# Optional RETRIEVAL: installation, wiring and RAG

The main package runs independently. Install `@codesoul-co/ditto-retrieval` when you need its providers, adapters or a separate search Worker. Basic Context selection and native Memory search do not require it.

## 1. Install and import

```sh
npm install @codesoul-co/ditto @codesoul-co/ditto-retrieval
```

| Entry point | Exports |
| --- | --- |
| `@codesoul-co/ditto-retrieval` | Worker, SEARCH contract, TargetRegistry, text/vector/hybrid/rerank/embedding/database adapters |
| `/adapters/memory` | Memory-to-retrieval and retrieval-to-Memory adapters |
| `/adapters/context` | Context RAG strategy adapter |

The retrieval package reuses the main package as a peer dependency. Importing augments TypeScript NodeContractMap; you must still register the Worker. Do not import the old main-package `/worker/retrieval` path or private src/dist files.

## 2. First search

```sh
node examples/package-basics/retrieval.ts Redis
```

<<< ../../examples/package-basics/retrieval.ts

The two documents are in-application demonstration data. Keyword filtering demonstrates wiring, not a database or vector index. Matches include a `guide.md#context` source; no match returns empty candidates.

## 3. Targets and strategies

TargetRegistry binds allowed targets to providers and default strategies. Select target/namespace from authenticated identity, not arbitrary model-selected production indexes or other tenants' data domains.

| Strategy | Operation | Dependencies |
| --- | --- | --- |
| text/keyword | Text query → search backend | Full-text database, search engine or application implementation |
| vector | Query vector/embedding → vector recall | Embedding model and dimension-compatible index |
| hybrid | Multiple recall paths → fusion | Providers, stable candidate IDs and fusion such as RRF |
| rerank | Initial candidates → ranking | Reranking model or application ranker |

Strategy names come from Registry configuration; arbitrary strings do not create implementations. Query/document embeddings, database connections and underlying SDK lifecycle remain application-owned.

## 4. Two ways to combine retrieval with Memory

**Internal long-term knowledge:** reviewed records live in Memory and can use native MEMORY.SEARCH. Delegate through `RemoteRetrievalSearchProvider` when separate search computation is useful, mapping results back to complete MemoryItem records.

**External knowledge bases:** providers access enterprise knowledge, document search or vector indexes. External candidates are not automatically long-term Memory and must not share permissions indiscriminately with private conversation records.

Map id, content, source and score explicitly into Context. A retrieval source ref and Context Reference.uri are different fields. Scores do not establish factual trustworthiness.

## 5. A complete RAG flow

```text
User request and identity
  → understand question / construct query
  → RETRIEVAL.SEARCH
  → filter candidates (tenant, version, source, duplicates)
  → CONTEXT.LOAD / UPDATE
  → CONTEXT.SELECT (budget)
  → INFER.REASONING.SAMPLE
  → verify citations
  → MEMORY checkpoint / INTERACTION.OUTPUT
```

A simple request can fit one Graph. Use Loop-selected stage Graphs for follow-up search, approval, recovery or multi-stage business work. Empty results should produce an evidence gap or another retrieval round, not invented sources.

The [4.1 RAG application](../../examples/patterns/rag-qa/README.md) includes request contracts, ingestion, querying, source location, Redis/Memory, answer/citation validation and actual output files.

## 6. Databases and deployment

The [provider reference](../worker-api/retrieval-providers.md) covers HTTP embeddings, SQL, Milvus, vectors, RRF, reranking and Memory/Context bridges. Use a database in-process or deploy RETRIEVAL in another process/host; Graph Node types stay the same.

Multi-process deployment requires authenticated transport, resource addresses and capability registration. Installing a package does not create search services, indexes or embedding endpoints.

## 7. Acceptance checks

Test empty queries/results, unknown targets, invalid strategies, dimension errors and backend failures. Verify provenance, tenant filtering, cancellation forwarding and timeouts. For full RAG, ensure each citation comes from selected evidence and explicitly communicate insufficient evidence.

[RETRIEVAL API](../worker-api/retrieval.md) · [Multi-source retrieval](../../examples/capabilities/retrieval/README.md)
