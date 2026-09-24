# 记忆任务应用工具

[English](README.md) · [四项记忆示例](../../../capabilities/memory/README.zh-CN.md)

- `storage.ts`：选择 SQLite/PostgreSQL/Qdrant，复用公开 `createContextWorker` / `createMemoryWorker` 注册 Redis Context 和数据库 Memory。连接、认证和作用域由可信应用管理。
- `adapters.ts`：`memory_project` 读取真实项目文件；`memory_publish` 原子发布任务报告。通过 `createInteractionWorker({tools:memoryTools(...)})` 注册，使用 `INTERACTION.ACT.TOOL` 调用。
- `domain.ts`：校验记忆保存许可、允许的偏好字段、逐字证据、阶段进展和最终说明，避免将模型建议直接作为授权或长期事实。

数据库实现复用 `../storage/`。`scoped-memory.ts` 的 namespace 来自宿主认证结果；`qdrant-memory.ts` 的 embedding 模型与维度由环境配置指定。长期记忆只使用 `kind=preference`；任务检查点使用 `kind=checkpoint`。二者都经过 Memory Worker，但不会混入同一次召回。
