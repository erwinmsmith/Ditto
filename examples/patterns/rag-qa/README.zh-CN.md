# 4.1 RAG 文档问答

[English](README.md) · [执行模式](../README.zh-CN.md) · [公开 API 调用](../../../docs/worker-api/rag-workflows.zh-CN.md)

从用户问题到可追溯答案的完整应用：问题理解 → 查询构造 → 文档接入与检索 → 内容筛选 → Redis 上下文组装 → 回答生成 → 原文引用与依据检查 → 持久化和输出。

适用于企业知识助手、制度问答、产品资料问答、合同与报告查询。素材均为虚构业务数据。

## 运行

需要 Node.js 24+、可用的 Redis、`ditto.yaml` 中配置的文本模型及对应环境变量。示例依赖由应用安装：

```sh
npm install
npm install --prefix examples/_shared/tools/storage/dependencies
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
npm run example:rag -- --provider deepseek
```

每次创建独立目录 `.examples-rag-tasks/cli-*`，输出目录路径和完整结果。默认问题为“借用示例设备要登记什么？借用超过七天怎么办？”。

```sh
# 产品资料：实际查询独立业务 SQLite 数据库
npm run example:rag -- --provider deepseek --sources product \
  --question 'Atlas 标准版和企业版各支持多少成员，数据保留多久？'

# 合同：保留响应与修复的区别、付款条件、金额及单位
npm run example:rag -- --provider deepseek --sources contract \
  --question '合同 D-204 年费和付款期限是什么？故障是否保证四小时修复？'

# 报告
npm run example:rag -- --provider deepseek --sources report \
  --question '报告里的本季度收入和同比增长率是多少？'

# 三类资料共同回答
npm run example:rag -- --provider deepseek --sources handbook,product,internal \
  --question '设备借用要登记什么？Atlas 标准版支持多少成员？内部知识库由谁检查？'

# 两份制度冲突：列出不同条款，不擅自选择生效版本
npm run example:rag -- --provider deepseek --sources handbook,conflict \
  --question '借用设备多少天后要重新确认归还日期？两份材料有不一致吗？'

# 保存筛选结果后停止；用上一步输出的 directory 恢复
npm run example:rag -- --provider deepseek --stop-after selected
npm run example:rag -- --provider deepseek --directory .examples-rag-tasks/cli-实际目录
```

`--stop-after` 支持 `indexed`、`retrieved`、`selected`、`report`。`--directory` 使用已保存的 `request.json`，不能同时传入新问题或新来源。新问题、补充澄清、新资料版本使用新的任务 ID 和目录。

## 请求与可信身份

`runRag(runtime, { request, model }, options)` 是应用入口，定义在 [index.ts](index.ts)。`openRag()` 在 [cli.ts](cli.ts) 中注册 Worker、工具和数据库连接。

```json
{
  "id": "question-001",
  "tenant": "demo",
  "principal": "alice",
  "question": "借用设备需要登记什么？",
  "sourceIds": ["handbook"]
}
```

线上控制器从认证会话设置 `tenant` 和 `principal`，从权限目录解析 `sourceIds`，不能直接相信客户端提交的身份字段。运行时绑定整个请求；传入不匹配的请求会在推理前失败。命令行目录相当于可信应用配置，不是面向匿名用户的上传接口。

## 三类资料的边界

| 来源 | 实际读取位置 | 用途 |
| --- | --- | --- |
| `document` | 任务目录内的 UTF-8 `.md` / `.txt` | 用户上传后规范化的文档 |
| `external` | 独立 `knowledge.sqlite` 的 `articles` 表 | 企业资料库或业务系统；不当作 Memory |
| `internal` | 通过 `MEMORY.GET` 读取获准的 `knowledge:<tenant>:*` 记录 | 经可信控制器审核写入的长期知识；不搜索任务检查点 |

演示默认按任务目录隔离 Memory SQLite。跨任务共享长期知识时，由宿主通过公开 MemoryStore 接口注入共享数据库并按租户隔离键；不要把独立演示目录当作企业全局知识库。

`memory.sqlite` 保存内部知识和任务检查点；`corpus.sqlite` 是本次任务的全文检索索引，两者职责不同。内部知识先由 Memory Worker 读取，再进入同一个有出处的检索索引。外部知识从独立业务表接入，替换第三方 SDK 的位置在 `examples/_shared/tools/rag/`。

提供自有资料时，准备一个新目录，放入 `request.json`、文档和可信的 `sources.json`：

```json
[
  {
    "id": "handbook",
    "tenant": "demo",
    "readers": ["alice"],
    "title": "设备借用制度",
    "kind": "document",
    "ref": "handbook.md"
  }
]
```

然后使用 `--directory` 运行。外部资料使用 `kind: "external"`，`ref` 指向以下表的记录 ID：

```sql
CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL
);
```

`title` 必须与目录一致。内部资料使用 `kind: "internal"`、`ref: "knowledge:demo:maintenance"`，通过公开 `MEMORY.WRITE` 写入 `{kind:"knowledge", tenant, title, text}`；完整调用见 API 文档。

PDF、Word、扫描件需要先用 [文档解析工具](../../_shared/tools/file-ingestion/README.zh-CN.md) 规范化，再接入这个文本索引。这里的引用定位是**规范化文本行号**，不冒充原始 PDF 页码。保留页面映射的应用可扩展 `Chunk` 元数据和解析适配器。

## 每个阶段做什么

| 阶段 | 输入与动作 | 校验与持久结果 |
| --- | --- | --- |
| 身份与来源检查 | 可信请求、来源目录；核对租户及读者 | 任一所选来源未获授权则拒绝，不把其内容送入模型 |
| 问题理解与查询构造 | 模型识别意图、待回答事项，构造 1–3 个短查询 | 含糊指代要求澄清；资料目录不替代对话历史；保存 `plan` |
| 文档接入 | 文件、外部数据库、获准的内部 Memory；按段落和长度切块 | 保存完整文本的 SHA-256 快照、来源类别、标题、行号；保存 `indexed` |
| 文档检索 | 中文双字词与英文词项进入 SQLite FTS5；BM25 排序 | 每个查询至多 12 项；合并查询结果，按片段 ID 去重；保存 `retrieved` |
| 内容筛选 | 模型逐项检查相关性、缺失信息和互相矛盾的条款 | 最多 8 个片段；冲突必须保留双方；保存 `selected` |
| 上下文组装 | `CONTEXT.LOAD` / `CONTEXT.UPDATE` 装入问题和选定证据 | 正文预算 10000 字符；超限明确失败，不悄悄丢掉冲突资料 |
| 回答生成 | 模型仅根据工作上下文回答 | 逐条结论绑定片段 ID 与连续原文摘录；禁止编造引用 |
| 依据检查 | 再次模型调用检查结论是否由其引用支持 | 原文匹配由程序严格验证；语义依据检查拒绝不支持的结论 |
| 输出 | 先写 `MEMORY.WRITE` 检查点，再调用发布工具 | 重新核对权限、来源快照；幂等保存 JSON 与 Markdown |

每次模型请求上限为 8192 输出 token（供应商可能将推理 token 计入其中），采样温度为 0；未正常完成的输出不进入后续步骤。常规有依据任务需要 4 次模型调用：规划、筛选、生成、依据检查。草稿校验或依据检查不通过时，允许携带校验反馈修订一次，单次运行最多 6 次模型调用；第二次仍失败则不发布。基础设施错误和未完成的模型输出直接报告失败。无检索结果只需规划；澄清结果不进行检索。无任何相关片段时不调用模型编造答案。模型检查提供额外质量控制，并不构成事实正确性的数学保证。

文档最多 100000 字符、200 个片段，单行最多 1600 字符，片段约 1800 字符。最多选择 20 个来源；候选序列化总长度最多 45000 字符。限制是应用示例的显式预算，不是 Core 的全局限制。

## 输出与消费

- `artifacts/answer.md`：面向用户的答案、缺失项、逐条原文引用、位置及版本。
- `artifacts/answer.json`：`question`、`plan`、`selection`、`evidence`、`answer`、`trace`、`grounding`，可供前端渲染引用卡片。
- `snapshots/<sha256>.txt`：对应资料的原文快照，支持复查行号和引用。
- Redis：本轮工作上下文；SQLite Memory：请求、计划、索引版本、检索结果、筛选结果、报告检查点。

`answer.status`：

| 状态 | 用户体验 |
| --- | --- |
| `answered` | 回答已获支持的事项，每条结论都有引用 |
| `insufficient-evidence` | 回答有依据的部分，明确缺少什么；没有依据时不输出事实结论 |
| `conflicting-evidence` | 展示双方条款和原文，交由资料负责人确认 |
| `needs-clarification` | 给出具体澄清问题；控制器收集回复后创建新请求 |

格式缩略示例（ID、版本和行号均来自运行结果）：

```json
{
  "answer": {
    "status": "answered",
    "claims": [{
      "text": "借用设备需登记设备编号、借用人和预计归还日期。",
      "citations": [{"chunkId": "实际片段ID", "quote": "借用示例设备需登记设备编号、借用人和预计归还日期。"}]
    }],
    "limitations": []
  }
}
```

## 恢复与失败语义

Redis 缓存过期后从数据库检查点重建 Context；Redis 或 Memory 服务不可用时失败，不退回进程内存。进程在检查点写入后被终止，可从对应阶段恢复。已经保存的报告只重试本地输出，不再次调用模型。

任务固定首次接入的资料版本；原文件后来变化不会偷偷改写已检索的依据。需要新版本时创建新任务。快照被修改、来源身份变化、权限被撤销时拒绝继续或重新输出。历史已交付文件不因撤权自动销毁；宿主应用负责产物访问权限、加密、保留期和删除策略。

所选来源是必需来源：数据库/文件读取失败不当作“没有证据”，也不生成看似完整的部分结果。无效引用、依据检查失败不发布；检查点保留，可重试当前阶段。一个任务目录由一个执行者负责，并发请求使用独立目录；这个示例不提供分布式任务锁。

## 验证与扩展

```sh
npm run check:examples:rag:types
npm run check:examples:rag:package -- --provider deepseek
npm run check
```

包验证将真实 tarball 安装到仓库外，复制应用与第三方适配器，进行无路径别名的严格类型检查、静默导入和运行时公开入口检查，然后用真实模型、Redis、SQLite、文件产物执行完整任务。覆盖四类业务、内部/外部知识、多来源、无依据/部分依据/澄清/冲突、恶意来源、存储故障、错误引用、不支持的结论、快照篡改、权限撤销、跨进程崩溃与缓存过期恢复。

这里验证的数据库是 SQLite + FTS5；不将其等同于 PostgreSQL、向量数据库或全部企业知识系统的验收。切换检索后端使用 `RetrievalTargetRegistry` / `RetrievalSearchProvider`，输出保留版本和定位信息；可接入已有公开的向量、混合检索和重排 Provider。Core 不需要为每种问答场景增加专用节点。

## Graph / Loop 调用结构

`runRagLoop` 是完整任务的 Loop 定义；`runRag()` 只调用一次 `runtime.loop()`。问题理解、检索、检查点、回答校验和交付都通过 `yield* graphStep(...)` 交给 Loop 执行；可复用的同步子计划沿用同一个执行预算。Graph 仅描述阶段内节点依赖，不嵌套子 Graph。

Loop 根据结果和检查点选择下一 Graph；回答修订会重复交出回答/检查 Graph，最多修订一次。此计划的总 Graph 执行预算为 1024 次，模型调用和资料大小另有更小的业务限制。调用轨迹可通过 `runtime.loop(runRagLoop, [input, options], {onGraph})` 观察。接口与取消语义见 [Graph / Loop 组合](../../../docs/worker-api/graph-loops.zh-CN.md)。
