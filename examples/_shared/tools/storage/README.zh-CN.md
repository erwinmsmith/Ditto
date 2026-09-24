# Context 与 Memory 存储接入

[English](README.md) · [应用工具](../README.zh-CN.md) · [请求理解示例](../../../capabilities/understanding/README.zh-CN.md)

Agent 示例使用 Redis 保存短期工作上下文，通过数据库 Memory 保存可恢复的会话记忆。业务状态、审批和产物账本独立存储，不替代 `MEMORY.*`。Core 提供公开协议与节点；应用安装 SDK、创建客户端并关闭资源。

## 安装与配置

使用 Node.js 24+：

```sh
npm ci --prefix examples/_shared/tools/storage/dependencies
```

启动可访问的 Redis 服务，在根目录 `.env` 中配置：

```dotenv
DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
```

Redis TTL 和 keyPrefix 读取 `ditto.yaml` 的 `workers.context.cache`。连接超时为 5 秒，不自动重连；连接失败向应用返回错误。不要将凭据写入 YAML 或版本库。

本地开发可在独立终端运行 `redis-server --bind 127.0.0.1 --port 6379`。SQLite 无需额外服务器，`openSqliteMemory(filename)` 必须接收持久化文件路径，不接受 `:memory:`。请求理解示例在各会话目录创建 `memory.sqlite`。

## 适配器

| 文件 | 职责 |
| --- | --- |
| [redis-context.ts](redis-context.ts) | 创建真实 Redis SDK 客户端；注入 `createContextWorker({ redis: { client, ...config.context.cache } })` |
| [sqlite-memory.ts](sqlite-memory.ts) | 文件数据库、WAL、事务串行化、唯一记忆 key 与资源关闭 |
| [sql-memory.ts](sql-memory.ts) | 复用 SQL MemoryStore：GET、QUERY、SEARCH、WRITE、UPDATE、DELETE |

```ts
const redis = await openRedisContext();
const memory = openSqliteMemory("./memory.sqlite");
const runtime = createDitto({
  config,
  workers: [
    createContextWorker({ redis: { client: redis, ...config.context.cache } }),
    createMemoryWorker({ store: memory.store, defaults: config.memory }),
  ],
});
// 使用 runtime.run(graph, input) 或 runtime.invoke("MEMORY.GET", input)。
// 应用结束时依次关闭 runtime、memory 和 redis。
```

`sql-memory.ts` 也供 [SQL 接入示例](../../../../docs/worker-api/examples/integrations/memory-sql.ts)复用；PostgreSQL/MySQL 连接池由对应应用适配器提供。本目录默认文件 SQLite 的验收不代表远程数据库验收。

SQLite 的 `memories` 表独立保存 `id`、`memory_key`、`content`、`metadata`。相同 key、相同内容的重复写入返回原记录；内容冲突被拒绝。显式 `MEMORY.UPDATE` 可更新既有记录。查询支持 key 过滤、ID 升序与分页；搜索使用 SQL 文本包含匹配，不提供向量排序。

## 会话与恢复

请求理解示例用独立 UUID 命名空间隔离会话，Context scope 包含命名空间和轮次版本。每轮交互完成后，通过 `MEMORY.WRITE` 保存用户/助手轮次、理解结果和产物引用，再将已归档版本号写回业务账本。记忆 key 固定为命名空间与版本组合；Memory 提交后进程中断，可重放相同写入而不产生重复记录。

`MEMORY.GET` 读取上次确认归档；`CONTEXT.LOAD({ scope })` 尝试读取 Redis。仅 `CONTEXT_NOT_FOUND` 触发从 Memory 建立缓存，其他存储故障直接报告。新输入再通过 `CONTEXT.UPDATE({ scope, add })` 合并。没有 SQLite Context 快照兜底。

业务数据库保留输入日志以做版本、证据与幂等校验，并记录最后确认的 Memory 版本；完整 Context 不写入业务数据库。Redis 数据按 TTL 过期，Memory 与业务文件由应用根据自身保留策略删除。会话命名空间不是身份认证凭据。

## 验收

```sh
npm run check
npm run check:examples:understanding:tasks:package
```

任务验收读取真实 Redis 数据与 TTL，检查独立 Memory 数据库中的会话内容，验证缓存过期后恢复、存储故障阻止推理、报告完成后补写记忆，以及 Memory 提交后强制结束进程的幂等恢复。包消费者单独安装 Redis SDK，使用 Core 公开入口执行全部任务。

[workers.ts](workers.ts) 的 `openAgentStorage(directory, config)` 统一创建 Redis Context 与文件 SQLite Memory Workers，并返回显式关闭函数。请求理解和[规划示例](../../../capabilities/planning/README.zh-CN.md)共用此接入。

## 长期记忆后端

[四项记忆任务](../../../capabilities/memory/README.zh-CN.md) 使用相同的 MemoryStore/MemorySearchProvider 契约：

- `postgres-memory.ts`：`openPostgresMemory(url,table)`，持久表、唯一 key、参数化 SQL 和事务；应用依赖 `pg`。
- `qdrant-memory.ts`：`openQdrantMemory(options)`，完整 payload、具名向量、原生 Cosine 检索；`content.text` 通过注入的真实 EmbeddingProvider 编码。无需 Qdrant SDK，使用有超时和响应大小限制的 REST 客户端。
- `scoped-memory.ts`：`scopedMemory(store,namespace)` 为六个 Memory 操作增加可信用户作用域。namespace 由宿主认证提供。
- `sql-memory.ts`：支持参数化字符串过滤 `key/namespace/kind`；JSON metadata 字段按 SQLite/PostgreSQL/MySQL 方言读取。后端检索为字符串匹配。

运行 `npm --prefix examples/_shared/tools/storage/dependencies install` 安装应用侧 SDK。`compose.memory.yaml` 提供仅绑定 localhost 的 Redis 16579、PostgreSQL 15432、Qdrant 16333；数据保存在 Docker volumes。它使用本地示例凭据，外部部署应使用宿主的认证配置。`docker compose -f examples/_shared/tools/storage/compose.memory.yaml down` 停止服务并保留数据。

环境变量：`DITTO_WORKER_MEMORY_POSTGRES_URL/TABLE`、`DITTO_WORKER_MEMORY_QDRANT_URL/COLLECTION/API_KEY`、`DITTO_WORKER_MEMORY_EMBEDDING_DIMENSIONS`；embedding 复用 `DITTO_WORKER_RETRIEVAL_EMBEDDING_BASE_URL/MODEL/API_KEY`。维度须与模型真实输出相同；模型身份或预处理变更需要新 collection。

应用负责单写者协调。SQL 唯一 key 约束、Qdrant 稳定 UUID/完成确认和任务操作 ID 核对提供明确的重试语义，但不提供跨库事务或通用并发 CAS。Qdrant 检查点只存 payload，不参与向量召回；GET/QUERY 不依赖 embedding。
