# RAG 文档素材

[handbook.md](handbook.md) 是虚构制度原文。[../fixtures.ts](../fixtures.ts) 在每个独立任务目录创建产品资料库、合同、季度报告、冲突条款和带恶意指令的来源，并保存可信来源目录与请求。内部知识经公开 Memory Worker 写入，外部资料保存在独立业务 SQLite。

引用保留来源类型、原文、快照哈希与精确行号。[英文译文](handbook.en.md)用于阅读，不修改实际任务使用的中文原文及其引用位置。
