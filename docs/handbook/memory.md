# 数据库、长期记忆与自定义 Memory 算法

Context 和 Memory 有不同生命周期。Context 是当前任务的工作集，完整 Agent 示例使用 Redis；Memory 是长期记录与检索入口，需要应用提供持久化数据库。可选 RETRIEVAL Worker 可以承担检索计算，但不会替你保存长期记忆。

## 1. 先分清三类状态

| 状态 | 示例 | 存放位置 |
| --- | --- | --- |
| 工作上下文 | 当前问题、工具观察、选中的资料 | Redis Context，允许 TTL 过期 |
| 长期 Memory | 用户偏好、已审核知识、会话记录、任务检查点 | SQL/文档/向量数据库的 Memory 适配器 |
| 业务事实 | 订单、支付、发布记录、幂等账本 | 业务系统数据库，以其提交结果为准 |

Memory 中写入“订单已取消”不等于业务系统真的取消订单。恢复时需要查询业务状态，不能只相信模型生成的总结。

## 2. Redis Context 配置

```sh
npm install redis@6.2.1
```

```ts
import { createClient } from "redis";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
const redis = createClient({ url: process.env.DITTO_WORKER_CONTEXT_REDIS_URL });
redis.on("error", error => { console.error("Redis connection failed", error.name); });
await redis.connect();
const contextWorker = createContextWorker({
  redis: { client: redis, ttlMs: 300_000, keyPrefix: "myapp:context:" },
});
// 注册 contextWorker；停止时先 runtime.close()，再 redis.quit()。
```

带 sources 的 LOAD 初始化/替换 scope，无 sources 的 LOAD 读取已有工作集。scope 的各字段共同决定 key，不存在 session→turn 的自动回退。UPDATE/COMPRESS 通过版本比较提交，冲突不会自动重试；SELECT 不延长 TTL。

Redis 中的数据过期后，从 Memory 或任务检查点重建 Context。连接错误是基础设施失败，不应悄悄切到进程内 Map 并继续声称支持持久恢复。

## 3. 文件 SQLite：可直接运行的持久化起点

示例复用 Node 内置 SQLite，不需要 SQLite npm 驱动：

```ts
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createMemoryWorker } from "@codesoul-co/ditto/worker/memory";
import { openSqliteMemory } from "./examples/_shared/tools/storage/sqlite-memory.ts";

const database = openSqliteMemory("./memory.sqlite");
const runtime = createDitto({ workers: [createMemoryWorker({ store: database.store })] });
try {
  const written = await runtime.invoke("MEMORY.WRITE", {
    memories: [{ key: "alice:language", content: { language: "zh-CN" }, metadata: { namespace: "alice" } }],
  });
  if (written.status !== "success") throw new Error(written.error?.message ?? "Write failed");
} finally {
  try { await runtime.close(); } finally { await database.close(); }
}
```

`openSqliteMemory` 是应用示例适配器，不是 npm 包导出。它使用文件数据库、WAL、参数化 SQL、事务和串行连接操作；[SQL 实现](../../examples/_shared/tools/storage/sql-memory.ts)可以完整阅读。示例 key 已存在且内容不同会报冲突；更新请使用已有 id 调用 UPDATE。

## 4. Store 和 Search 分开实现

| 接口 | 必须实现的方法 | 返回值 |
| --- | --- | --- |
| MemoryStore | get / query / write / update / delete | 原始 Memory 输出，不包装 NodeResult |
| MemorySearchProvider | search | `{memory,score?}[]`，保留完整记录与稳定 id |

`createMemoryWorker({store,search?})` 中，显式 search 优先；不传时使用 store 自带的 search。都没有时 SEARCH 会失败，不会自动实现向量搜索。

Store 是事实存储；Search 是可替换的召回和排序策略。Graph 使用 MEMORY.SEARCH，不需要知道后端是 SQL LIKE、全文索引、向量库还是多路融合。

## 5. 六种操作的选择

- **GET**：知道 id/key 时精确读取，适合会话和检查点恢复。
- **QUERY**：按可信 filter/orderBy/cursor 枚举记录；cursor 应由适配器稳定生成。
- **SEARCH**：按相关性找内容，query/strategy/options 由搜索适配器定义和验证。
- **WRITE**：创建新 Memory，返回数据库生成的 id；不要假设业务 key 自动全局幂等。
- **UPDATE**：按 id 部分更新；metadata 传入时替换整个 metadata 对象，适配器不应擅自深合并。
- **DELETE**：删除实际存在的 id，返回本次真正删除的记录标识。

Runtime/Worker 外层返回 NodeResult；底层数据库输出是原始类型。详见 [MEMORY 逐节点契约](../worker-api/memory.zh-CN.md)。

## 6. 自定义算法：关键词候选 + 时间排序

下面示例连接真实文件 SQLite，写入两条记录，先在数据库召回关键词候选，再按时间排序：

```sh
node examples/handbook/memory-ranking.ts
```

<<< ../../examples/handbook/memory-ranking.ts

预期 newer 排在 older 前面；再次运行不会新增重复示例记录。score 是应用定义的 `1/(1+ageDays)`，不是概率或模型置信度。固定评估时间让示例可重现；上线时使用明确的时钟与时间字段规则。

这只重排最多 100 条数据库候选，不保证召回全库中最新的所有相关记录。数据量增长时，把时间和相关性排序下推到数据库/索引，或者设计可分页召回；不要把小样例误当作大规模检索系统。

## 7. 向量记忆的完整链路

```text
审核后的内容
  → 规范化与稳定 id
  → embedding（记录模型、版本、维度）
  → 写入事实存储
  → 更新向量索引 / outbox
  → MEMORY.SEARCH(query)
      → query embedding
      → 租户过滤 + 向量召回
      → 回查事实记录，剔除已删除/过期项
      → 可选 rerank
      → 返回完整 MemoryItem + score
```

向量库不是授权系统。租户、namespace、可见性和有效期应在召回阶段过滤，回查时再核验。数据库与索引不是同一事务时，使用 outbox/重试队列和版本号处理索引延迟，删除也要传播到索引。

不要比较来自不同 embedding 模型/维度的向量。切换 embedding 版本时新建或重建索引，并保持查询模型与索引一致。score 的含义由策略声明：余弦、距离、BM25 或融合分数不可混作相同置信度。

## 8. PostgreSQL、MySQL、Qdrant、Milvus

[存储适配器说明](../../examples/_shared/tools/storage/README.zh-CN.md)提供数据库依赖与连接方式；[记忆任务](../../examples/capabilities/memory/README.zh-CN.md)包含 SQLite、PostgreSQL 与 Qdrant 路径；[检索 Provider](../worker-api/retrieval-providers.zh-CN.md)说明 SQL 与 Milvus 的连接契约。

接入自己的 SQL 驱动时，实现 `rows` 与 `transaction`；事务回调必须绑定同一连接。PostgreSQL 参数占位符与 MySQL/SQLite 不同，由适配器转换或原生实现；不能把模型生成的 SQL 当作任意可执行字符串。

数据库 URL 和密码在应用环境变量中读取。`ditto.yaml` 只提供行为默认值，不会替你安装驱动、创建表、建立连接、迁移 schema 或保证索引就绪。

## 9. 写入策略也是算法的一部分

先选择适合长期保存的内容，再做脱敏、去重、来源验证和有效期判断。CONTEXT.SELECT 的 purpose=memory 可以帮助选择，但不是完整的隐私/授权政策。每条 Memory 建议记录来源、可信主体、创建时间、版本和失效条件。

对已有事实进行补充时使用 UPDATE 并处理冲突；不同来源互相矛盾时保留各自来源及状态，不能仅凭最近生成的答案覆盖已验证事实。任务 checkpoint 与知识 Memory 采用不同 kind/namespace。

## 10. 验收清单

验证写入后关闭并重新打开数据库能读取；验证更新/删除、分页、空结果、非法过滤与租户边界；验证向量维度不匹配和索引失败不返回假成功；验证取消、连接关闭及 Redis 过期后的恢复。

SQLite 测试通过不代表 PostgreSQL、MySQL、Qdrant 或 Milvus 已在你的部署环境验证。[可选检索包](retrieval.md)只在需要独立检索资源时安装。
