# Execution patterns

[简体中文 / Detailed index](README.zh-CN.md) · [All examples](../README.md)

These 16 patterns combine Agent capabilities and control flow. Each directory documents its workflow, composition and design requirements.

- [rag-qa](rag-qa/README.md)
- [web-search-qa](web-search-qa/README.md)
- [deep-research](deep-research/README.md)
- [react](react/README.md)
- [plan-and-execute](plan-and-execute/README.md)
- [reflection](reflection/README.md)
- [candidate-selection](candidate-selection/README.md)
- [tool-chain](tool-chain/README.md)
- [human-in-the-loop](human-in-the-loop/README.md)
- [multi-agent](multi-agent/README.md)
- [supervisor](supervisor/README.md)
- [handoff](handoff/README.md)
- [specialist-routing](specialist-routing/README.md)
- [debate](debate/README.md)
- [auto-repair](auto-repair/README.md)
- [long-running](long-running/README.md)

## Complete scenario contract

Use [RAG question answering](rag-qa/README.md) as the application and verification reference. Execution patterns connect a trusted user request to actual deliverables, documenting stage inputs/outputs, authority, stopping conditions and failures. A model call or an isolated node is not a complete scenario.

Provide a runnable CLI and programmatic entry, real source/system integration, attributable user results, durable state and recovery. Context uses Redis; Memory uses a database; business/vendor adapters remain separately configured application tools. Compose Workers through public package exports and Runtime / Graph / Loop, without source-tree imports.

Verify normal business outcomes, missing information, faults, cancellation, process interruption and cache expiry against actual artifacts/effects. Report real model/storage experiments separately from explicit unit doubles. README and API documentation include complete calls and scope limits.

[Web search question answering](web-search-qa/README.md)
