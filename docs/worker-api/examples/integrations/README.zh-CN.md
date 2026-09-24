# Worker 数据库接入示例

[English](README.md) · **简体中文** · [所有示例](../guide.zh-CN.md) · [Worker API](../../README.zh-CN.md)

这些示例在应用侧创建 SDK、注入 Worker、执行真实调用并关闭资源。数据库与驱动不进入 Ditto Core。所有命令在**项目根目录**执行，需要 Node 24+。

| 文件 | 做什么 | 实际操作 |
| --- | --- | --- |
| [context-redis.ts](context-redis.ts) | CONTEXT 接已连接的 node-redis client | LOAD、UPDATE、SELECT、COMPRESS、再次 LOAD；SELECT 不写回；结束删除本次随机 scope |
| [memory-sql.ts](memory-sql.ts) | MemoryStore + 原生 keyword search，支持 SQLite、PostgreSQL、MySQL | 创建随机示例表；执行六种 MEMORY 操作；参数化 SQL、JSON 映射、事务和分页；结束删除该表 |
| [memory-milvus.ts](memory-milvus.ts) | Milvus 同时作为完整记录存储与向量搜索后端 | 创建随机 collection/向量索引并加载；CRUD、query、cosine search；结束删除该 collection |
| [shared.ts](shared.ts) | 示例共用的 SDK 加载、NodeResult 检查和 MEMORY 调用流程 | runMemoryExample 接收任意 MemoryResources，依次 WRITE → GET → QUERY → SEARCH → UPDATE → DELETE |

三个入口只在直接运行时调用 main；导入适配器不会连接服务或写数据。SQL/Milvus 示例需要在目标数据库中创建与删除表/collection 的权限，只清理本次创建的随机资源。使用开发数据库运行。

## 安装与配置

```bash
npm ci
# 只安装需要的外部 SDK；SQLite 不需要额外驱动。
npm install --prefix /tmp/ditto-worker-example-sdk --no-audit --no-fund --ignore-scripts \
  redis@6.2.1 pg@8.23.0 mysql2@3.24.4 @zilliz/milvus2-sdk-node@3.0.6
```

把根目录 [`.env.example`](../../../../.env.example) 中需要的变量填入本地 `.env`。npm 示例命令使用 `--env-file-if-exists=.env`，不会覆盖 shell 已设置的环境变量。

```dotenv
# Examples：SDK 安装位置；也可省略，使用应用本地 node_modules。
DITTO_EXAMPLES_SDK_DIRECTORY=/tmp/ditto-worker-example-sdk

# Workers / CONTEXT
DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379

# Workers / MEMORY：只填写选用的后端。
DITTO_WORKER_MEMORY_POSTGRES_URL=postgresql://user:password@127.0.0.1:5432/ditto
DITTO_WORKER_MEMORY_MYSQL_URL=mysql://user:password@127.0.0.1:3306/ditto
DITTO_WORKER_MEMORY_MILVUS_ADDRESS=127.0.0.1:19530
DITTO_WORKER_MEMORY_MILVUS_TOKEN=
```

SDK 由应用管理；`DITTO_EXAMPLES_SDK_DIRECTORY` 只由本目录的辅助函数读取。Redis 策略、TTL、keyPrefix 和 MEMORY 默认 queryLimit/searchLimit 仍读取根目录 [`ditto.yaml`](../../../../ditto.yaml)。数据库地址、密码和 token 放 env。

## CONTEXT → Redis

Redis 服务可用后运行：

```bash
npm run example:worker:redis
```

示例用同一 scope 完成四种操作，并从 Redis 重新读取结果。关键接入代码为：

```ts
const worker = createContextWorker({
  ...(config.context.policy ? { policy: config.context.policy } : {}),
  redis: { client, ...config.context.cache },
});
await runtime.invoke("CONTEXT.LOAD", { scope, sources });
await runtime.invoke("CONTEXT.UPDATE", { scope, add });
const selected = await runtime.invoke("CONTEXT.SELECT", { scope, purpose: "infer" });
```

完整文件处理了可选 policy 字段与连接清理。替换后端时改用 `services: { stateStore }`，scope 和 Graph 不变。详细语义见 [CONTEXT API](../../context.zh-CN.md)。

## MEMORY → SQL

```bash
# 本地内存 SQLite，可直接运行，无需数据库服务或连接配置。
npm run example:worker:sql -- sqlite

# 先创建目标数据库并配置账号。
npm run example:worker:sql -- postgres
npm run example:worker:sql -- mysql
```

`openSqlDatabase(dialect)` 用 Node DatabaseSync、pg.Pool 或 mysql2 Pool 创建连接资源。`createSqlMemoryStore(database, table)` 返回同时包含 CRUD 与 search 的对象：

```ts
const store = createSqlMemoryStore(database, table);
const worker = createMemoryWorker({ store });
const runtime = createDitto({ workers: [worker] });
const result = await runtime.invoke("MEMORY.SEARCH", {
  query: "language", strategy: "keyword", limit: 5,
});
```

记录使用 id / memory_key / content / metadata 四列；content、metadata 序列化为 JSON 文本，允许中文、对象和数组。表名严格限制为标识符，所有查询值绑定为参数。key 允许多个记录；GET 同时给 ids/keys 时取并集。

QUERY 支持 `filter: { key }`、`orderBy: [{ field: "id", direction: "asc" }]`，按 id 做游标分页。返回 nextCursor 时传给下一次 QUERY；数据变化时它不提供跨请求快照。SEARCH 是数据库内大小写不敏感的字面子串匹配，`%`、`_`、`!` 被转义；不会把它当全文排名或向量搜索。不支持的过滤、排序和策略会报错。

WRITE/UPDATE/DELETE 使用事务；UPDATE 先检查所有目标，再修改。PostgreSQL/MySQL 在同一事务连接中锁定目标记录，SQLite 串行访问单连接。metadata 更新替换整个对象；DELETE 只返回实际找到并删除的 ID，重复删除返回空数组。

应用接入时使用自己的持久表和 schema 初始化逻辑，复用一个连接池；不要把 main 中创建/删除随机表的演示生命周期直接用于业务表。[MEMORY API](../../memory.zh-CN.md) · [pg 查询](https://node-postgres.com/features/queries) · [MySQL2](https://sidorares.github.io/node-mysql2/docs)。

## MEMORY → Milvus

配置 Milvus 地址与可选 token 后运行：

```bash
npm run example:worker:milvus
```

collection 包含：

| 字段 | 用途 |
| --- | --- |
| id | VARCHAR 主键，UUID |
| memory_key | GET/filter 使用的业务 key |
| payload | 完整 MemoryItem 的 JSON，包括 content、metadata 和可选 key |
| vector | FLOAT_VECTOR，示例为 3 维；FLAT 索引、COSINE 度量 |

`createMilvusMemoryStore(client, collection)` 使用原生 query/insert/upsert/delete/search，并请求 Strong consistency。读取和检索都还原完整 MemoryItem；不需要额外 SQL 数据库保存内容。

```ts
const worker = createMemoryWorker({
  store: createMilvusMemoryStore(client, collection),
  concurrency: 1,
});
// 写入 content 包含文字及对应向量。
await runtime.invoke("MEMORY.WRITE", {
  memories: [{ key: "preference", content: { text: "偏好中文", vector: [1, 0, 0] } }],
});
// SEARCH.query 为相同维度、非零的向量。
const hits = await runtime.invoke("MEMORY.SEARCH", {
  query: [1, 0, 0], strategy: "vector", limit: 5,
});
```

三维手工向量仅用于演示数据库操作，不代表语义 embedding。实际使用时由外部 embedding Provider、可选 RETRIEVAL 或数据库内置能力生成向量，保持文档与查询的模型、维度、度量一致。该示例的 WRITE/UPDATE 接收已生成的向量，修改 text 时应同时修改 vector；不会隐式调用模型。

QUERY 支持 `{ key }` 过滤及 limit，是有界查询；本示例不实现游标和排序，显式传入会报错。GET 超过 10000 条时要求拆分请求。payload 受 65535 字节限制，业务 key 受 255 字节限制。

Milvus 适配展示单写入方 collection 的读改写，Worker concurrency=1 只约束本副本。UPDATE 的读改写和批量修改没有 SQL 事务保证；共享 collection 的多写入方需由应用协调。发生部分写入或删除数不符时明确失败，应对账后决定如何恢复，不能假定整批回滚。[Milvus Node SDK](https://github.com/milvus-io/milvus-sdk-node) · [向量搜索接口](https://milvus.io/api-reference/node/v2.6.x/Vector/search.md)。

## CONTEXT 缓存与可选检索

[context-retrieval.ts](context-retrieval.ts)：实际 SQLite FTS5 建表、参数化查询与 BM25 排序；同一 Provider 分别在 CONTEXT 内直接运行和经 RETRIEVAL Worker 执行。Graph 显式连接 LOAD → SELECT，部署位置由 runtime.run 的 workers 映射决定。还展示本地 TTL/LRU 缓存、共享有界队列、ReferenceResolver 读取 README，以及 SELECT 不覆盖原缓存的行为。例子断言两种检索模式结果一致，关闭 Runtime 后释放数据库；无需密钥或额外 SDK。

```sh
npm run example:worker:context-retrieval
```

参数来自根 ditto.yaml 的 workers.context.localCache/queue；若要替换 Redis，替换 stateStore 即可。真实 SQL/Milvus 的连接池仍由应用持有，检索 Provider 可原样用于内联或独立 Worker。

SQL 适配器实现复用于[应用存储目录](../../../../examples/_shared/tools/storage/README.zh-CN.md)。复制 SQL 示例到独立应用时，同时复制 `sql-memory.ts` 并调整相对导入；请求理解示例使用持久化文件 SQLite，完整任务验收包含真实 Redis。
