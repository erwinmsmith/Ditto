# 3.6 记忆能力

[English](README.md) · [能力目录](../README.zh-CN.md) · [API 调用方式](../../../docs/worker-api/memory-workflows.zh-CN.md)

四个示例通过公开 `MEMORY.*`、`CONTEXT.*`、`INFER.*` 和 Runtime Graph 完成项目进度说明任务。Context 使用 Redis；长期记忆和阶段检查点存入选定的关系型或向量数据库。

| 示例 | 流程 | 可验证产物 |
| --- | --- | --- |
| [search.ts](search.ts) | `MEMORY.SEARCH` 找到用户的沟通偏好，加载到 Redis，再调用模型 | 按记忆中的语言、详略生成进度说明，并记录记忆 ID 与版本 |
| [write.ts](write.ts) | 用户启用保存；模型提取偏好；应用核对原文与准入规则；`MEMORY.WRITE` 保存 | 后续新任务能检索并使用同一长期记忆 |
| [update.ts](update.ts) | 读取已存偏好；核对修订意图；`MEMORY.UPDATE` 更新同一 ID | 使用新偏好；向量后端同步重新生成文档向量 |
| [task-state.ts](task-state.ts) | 模型计算项目进展；保存 `progress`；重新进入时通过 `MEMORY.GET` 恢复 | 从已保存进展生成报告，保留原输入快照，无需重复已提交阶段 |

产物是 `artifacts/<taskId>.json`，包含生成的进度说明、引用的记忆 ID/版本、语言风格及任务进展。

## 数据库后端

| `--backend` | 真实存储 | 检索方式 | 依赖 |
| --- | --- | --- | --- |
| `sqlite` | 文件 SQLite | 参数化 SQL 关键词检索 | Node.js 24 内置 SQLite |
| `postgres` | PostgreSQL | 参数化 SQL 关键词检索 | 应用侧 `pg`、PostgreSQL 服务 |
| `qdrant` | Qdrant：记录 payload + 具名向量 | 真实 embedding + 数据库原生 Cosine 查询 | Qdrant 服务、兼容 HTTP 的 embedding 服务 |

三种后端共用 `MemoryStore` / `MemorySearchProvider` 契约和任务编排。Qdrant 保存完整 Memory 记录，检查点以无向量 payload 保存；只有 `kind=preference` 的长期记录生成 `text` 向量。SQL 的关键词检索不冒充语义检索。数据库驱动、连接和迁移属于应用，未加入 Core 包依赖。

## 运行

```bash
npm install
npm --prefix examples/_shared/tools/storage/dependencies install
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:16579
npm run example:memory:search -- --backend sqlite
npm run example:memory:write -- --backend sqlite
npm run example:memory:update -- --backend postgres
npm run example:memory:task-state -- --backend qdrant
```

配置真实推理模型到 `ditto.yaml` / `.env`，并按 [存储配置](../../_shared/tools/storage/README.zh-CN.md) 启动所需数据库。可用 `examples/_shared/tools/storage/compose.memory.yaml` 启动隔离的本地服务：

```bash
docker compose -f examples/_shared/tools/storage/compose.memory.yaml up -d
export DITTO_WORKER_MEMORY_POSTGRES_URL=postgresql://postgres:ditto_example@127.0.0.1:15432/ditto
export DITTO_WORKER_MEMORY_QDRANT_URL=http://127.0.0.1:16333
export DITTO_WORKER_MEMORY_QDRANT_COLLECTION=agent_memories
# 以下模型、维度、地址与凭据必须对应同一个 embedding 服务。
export DITTO_WORKER_RETRIEVAL_EMBEDDING_BASE_URL=https://open.bigmodel.cn/api/paas/v4
export DITTO_WORKER_RETRIEVAL_EMBEDDING_MODEL=embedding-3
export DITTO_WORKER_MEMORY_EMBEDDING_DIMENSIONS=2048
# DITTO_WORKER_RETRIEVAL_EMBEDDING_API_KEY 放入不提交的 .env。
```

默认 CLI 创建随机任务目录、实际 `project.json`、隔离用户及演示记忆，再运行任务。SQLite 的用户长期库为该目录的 `memory.sqlite`；新会话应复用同一库和可信用户身份。PostgreSQL 表与 Qdrant collection 为配置指定的持久库。嵌入模型调用与文本生成调用分别配置。

```bash
npm run example:memory:task-state -- --backend postgres --checkpoint
# 使用上一步打印的目录继续；后端从 request.json 读取
npm run example:memory:task-state -- --directory .examples-memory-tasks/cli-XXXXXX
```

不经过 CLI 时，导入入口的 `run(runtime,{request,model},options)`；从可信控制器传入 `tenant/user/remember`，再使用 `openMemoryStorage({backend,directory,namespace,config})` 注册 Worker。所有入口导入均无连接与任务副作用。

## 记忆规则与恢复

- 长期记忆 key 为 `<tenant>:<user>:memory:*`，检查点为 `<tenant>:<user>:task:<taskId>:*`。查询限定 `kind=preference`；任务检查点不是企业知识库，不参与语义召回。
- 写入示例只允许明确同意保存的、持久的沟通偏好。模型只提出语言/详略和逐字证据，不能授予保存权限。其他业务请显式扩展规则，不保存密码、临时闲聊或模型猜测。
- 作用域适配器在 GET、QUERY、SEARCH、WRITE、UPDATE、DELETE 上约束可信控制器指定的 namespace。跨用户 ID 不可被更新。宿主仍负责认证身份；模型内容不能决定身份。
- 保存候选后才修改长期记忆；修改前检查现有内容与操作 ID。写入已生效但响应丢失或进程中断时，通过读取核对，不重复更新或升级版本。
- 候选、进展和报告分别通过 `MEMORY.WRITE` 提交。报告提交后再原子发布文件，文件失败可重试，不重复推理。
- Redis 仅保存工作集；仅缓存未命中或过期时由数据库重建。数据库、Redis 或 embedding 不可用时报告失败，不切换到内存或另一数据库。
- 每用户、每任务使用单活动写控制器。SQL 事务与 Qdrant `wait=true` 不构成跨服务事务；Qdrant 的 key 冲突核对不是多写者 CAS。多副本应用需外部锁或条件写策略。
- Qdrant collection 固定 embedding 服务/模型、维度及预处理标识。变更模型即使维度相同也必须新建 collection 并重建索引；只修改配置不能复用旧向量。

## 验收

```bash
npm run check
# 默认要求三种真实后端，缺少配置直接报错，不跳过
npm run check:examples:memory:tasks
npm run check:examples:memory:tasks:package
# 单后端开发验证
npm run check:examples:memory:tasks -- --backend qdrant
```

验收执行真实模型、真实 embedding、Redis、文件 SQLite、PostgreSQL 和 Qdrant，包括新任务消费长期记忆、分页/隔离、更新向量、写入与更新后 SIGKILL、阶段恢复、缓存过期、存储故障、未授权保存、模型错误候选、嵌入维度/身份错误、取消和发布重试。包验收在仓库外安装实际 npm tarball，检查无 paths 的严格类型、公开入口、静默导入，再执行任务。

产物、数据库目录、日志与 `AGENTS.md` 已纳入忽略规则。MySQL/Milvus 的单节点适配示例见 [数据库集成](../../../docs/worker-api/examples/integrations/README.zh-CN.md)；不将本模块的三后端任务验收等同于这些后端的任务验收。

存储故障用真实 SQL 表暂不可用及 Qdrant HTTP 503 代理注入；恢复后继续使用原数据库。向量维度错误在真实 embedding 返回后注入，不以固定向量替代模型。

## Graph / Loop 组合

本模块在 `shared.ts` 导出完整任务的 `run*Loop`。`run*()` 入口只调用一次 `runtime.loop()`，阶段 Graph 通过执行计划交给 Loop 统一调度；子计划复用同一个 1024 次 Graph 执行预算，检查点恢复、分支和重复不会另起调度器。Graph 内保留节点依赖，资料、模型和业务操作仍经过公开 Worker。详见 [Graph / Loop API](../../../docs/worker-api/graph-loops.zh-CN.md)。
