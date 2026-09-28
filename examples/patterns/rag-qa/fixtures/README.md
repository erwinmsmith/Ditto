# RAG fixtures

[handbook.md](handbook.en.md) is an English translation of the fictional policy fixture. The actual task reads the original Chinese [source document](handbook.md); translations do not change its citation line ranges or snapshot hash.

[The fixture controller](../fixtures.ts) creates fictional policy, product, contract, report, conflicting and hostile material per task, together with a trusted source catalog and request. Internal knowledge is seeded through the public Memory Worker; external knowledge uses an independent business SQLite database. Citations retain source kind, original text, snapshot hash and exact line range.
