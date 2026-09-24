# RAG fixtures / 文档素材

[handbook.md](handbook.md) 是虚构制度原文。[../fixtures.ts](../fixtures.ts) 在每个独立任务目录创建产品资料库、合同、季度报告、冲突条款和带恶意指令的来源，并保存可信来源目录与请求。内部知识经公开 Memory Worker 写入，外部资料保存在独立业务 SQLite。

The fixture controller creates fictional policy, product, contract, report, conflicting and hostile material per task. Internal knowledge is seeded through the public Memory Worker; external knowledge uses an independent business SQLite database. Citations retain source kind, original text, snapshot hash and exact line range.
