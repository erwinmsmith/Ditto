# 内容处理

[English](README.md) · [基础能力](../README.zh-CN.md) · [API 调用指南](../../../docs/worker-api/content-workflows.zh-CN.md)

七个入口通过公开 Runtime / Graph API 完成资料读取、真实模型处理、内容校验、模型复核和文件交付。Context 使用 Redis，检查点通过 Memory Worker 保存到 SQLite；文件与渲染规则位于 [应用工具目录](../../_shared/tools/content/README.zh-CN.md)。

| 能力 | 入口 | 任务与验收 |
| --- | --- | --- |
| 内容生成 | [generate.ts](generate.ts) | 根据批准资料生成新的试点通知，保留产品、日期、配额、审批与导出限制 |
| 内容改写 | [rewrite.ts](rewrite.ts) | 将口语化草稿改写为清晰、礼貌的团队通知，保留原文关键事实 |
| 内容总结 | [summarize.ts](summarize.ts) | 总结资料和长篇会议纪要，去除重复讨论，正文不超过 380 字符 |
| 内容扩展 | [expand.ts](expand.ts) | 逐字保留原始首段，补充有来源支持的启用说明和申请步骤 |
| 翻译 | [translate.ts](translate.ts) | 中译英，保留产品编号、ISO 日期、数字与限制，检查指定术语 |
| 格式转换 | [convert.ts](convert.ts) | 保持草稿标题、正文及段落顺序，转换为结构化 JSON、Markdown 和 HTML |
| 引用生成 | [cite.ts](cite.ts) | 生成含多个来源的启用指南，将引用定位到原文块、行号及快照哈希 |

## 安装与运行

需要 Node.js 24+、可用 Redis 和真实模型。模型配置使用根目录 `ditto.yaml` / `.env`，Redis 地址使用 `DITTO_WORKER_CONTEXT_REDIS_URL`。

```sh
npm ci
npm ci --prefix examples/_shared/tools/storage/dependencies
npm run example:content:generate
npm run example:content:rewrite
npm run example:content:summarize
npm run example:content:expand
npm run example:content:translate
npm run example:content:convert
npm run example:content:cite
```

CLI 使用独立 `.examples-content-tasks/cli-*` 目录，创建用于演示的产品资料、草稿和会议纪要。资料是测试数据，不表示真实产品承诺。使用 `--provider <name>` 可选择配置中的模型。

暂停于已生成、校验并保存草稿之后，随后复核并交付：

```sh
npm run example:content:translate -- --checkpoint
npm run example:content:translate -- --directory .examples-content-tasks/cli-XXXXXX
```

第二条命令的目录替换为第一条输出的实际路径。相同任务 ID 对应固定输入和资料哈希；修改要求或资料应新建任务。

## 文件交付

每个模式均输出以下文件，以便复用同一套内容和出处：

- `artifacts/content.json`：标题、语言、分节正文、逐节引用及可定位的引用表。
- `artifacts/content.md`：正文、来源链接与原文引文。
- `artifacts/content.html`：可直接打开的静态文档，正文转义，引用可跳转至出处说明。
- `artifacts/review.json`：内容复核结果。
- `artifacts/sources/*.md`：与生成时一致的原文快照。
- `artifacts/manifest.json`：交付文件的 SHA-256 和字节数。

模型不生成文件路径或 HTML 代码。应用根据结构化内容生成各格式、保存原文快照并回读核对；来源行号和哈希由应用计算。格式转换专门验证正文逐字不变，其他模式验证各自的内容处理要求。

## 校验与恢复

首次读取资料时验证文件类型、大小和控制器提供的哈希，拒绝符号链接及修改后的资料。资料提交到 Memory 后，恢复使用已保存快照；任务期间原文件变化不会悄悄替换生成依据。

生成步骤和复核步骤分别调用真实模型。应用校验结构、语言、字数、保留字段、数字、引用原文及来源覆盖；再由模型检查事实一致性、重要内容覆盖、转换要求和引用支持关系。复核未通过不发布文件。模型复核是自动化质量检查，不代替人工编辑，也不验证资料本身是否符合外部现实。

通过 `MEMORY.GET/WRITE` 保存 `input`、`material`、`draft`、`review`、`report`。Redis 缓存过期时由已提交资料与草稿重建；Redis / Memory 不可用时停止，不回退到进程内缓存。重复发布相同内容保持文件一致，冲突文件会报错；清理冲突后可使用同一目录继续，无需重新生成已保存的草稿和复核。

模型响应被截断、内容不合格或引用无法核实时，流程报错，不交付部分文本。生成与复核使用 `generation: { temperature: 0, maxTokens: 8192 }`；该参数控制模型输出预算，正文仍受各模式长度要求限制。

## 端到端验收

```sh
npm run check
npm run check:examples:content:tasks
npm run check:examples:content:tasks:package
```

32 个场景覆盖七项正常任务、七项 Redis 过期恢复、文件缺失/符号链接/被修改、已提交快照恢复、存储不可用、输入冲突、错误数字/语言/引用、格式转换丢失内容、复核拒绝、部分发布失败、取消以及跨进程恢复。

跨进程场景在资料、草稿、复核提交后，以及文件实际发布后发送 `SIGKILL`，由新进程继续并核对模型调用次数、Memory、文件内容、引用行号和哈希。包验收在仓库外安装 npm tarball，验证无 paths 别名的严格类型、公开入口边界与七个静默导入，再运行整个任务套件。真实模型或 Redis 缺失会失败，不跳过对应能力。

扩展模式由应用从已提交快照逐字保留原文首段，模型只生成新增分节；组合后统一校验和复核。

## Graph / Loop 组合

本模块在 `shared.ts` 导出完整任务的 `run*Loop`。`run*()` 入口只调用一次 `runtime.loop()`，阶段 Graph 通过执行计划交给 Loop 统一调度；子计划复用同一个 1024 次 Graph 执行预算，检查点恢复、分支和重复不会另起调度器。Graph 内保留节点依赖，资料、模型和业务操作仍经过公开 Worker。详见 [Graph / Loop API](../../../docs/worker-api/graph-loops.zh-CN.md)。
