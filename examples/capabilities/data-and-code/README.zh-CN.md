# 数据与代码能力

[English](README.md) · [公开 API 调用](../../../docs/worker-api/data-code-workflows.zh-CN.md) · [工具配置](../../_shared/tools/data-and-code/README.zh-CN.md)

十二个示例通过公开 Runtime/Graph 组合 `MEMORY`、`CONTEXT`、`INFER` 和 `INTERACTION`。模型提出 SQL、程序、修改方案或分析操作；应用工具实际执行并核对结果；模型再解释已取得的证据。Context 使用 Redis，检查点使用文件 SQLite Memory，业务数据保存在独立 SQLite 数据库。

| 能力 | 入口 | 输入与结果 |
| --- | --- | --- |
| 自然语言查询数据库 | [query.ts](query.ts) | 根据问题和真实表结构生成参数化 SQL，执行只读查询并解释结果 |
| 数据清洗 | [cleaning.ts](cleaning.ts) | 生成并执行清洗程序，处理缺失值、无效日期、异常数值、格式及重复记录 |
| 数据探索 | [exploration.ts](exploration.ts) | 读取字段缺失情况、分布、状态计数与 Pearson 相关系数 |
| 数据计算 | [calculation.ts](calculation.ts) | 生成并执行统计程序，计算已付款订单量、金额、均值和地区汇总 |
| 数据可视化 | [visualization.ts](visualization.ts) | 根据计算结果生成 PNG/SVG 分组柱状图及图表数据 JSON |
| 数据解释 | [interpretation.ts](interpretation.ts) | 把真实指标转为可读结论，逐项绑定结果中的证据 |
| 代码库检索 | [code-search.ts](code-search.ts) | 使用 ripgrep 搜索源码快照，返回文件、行号和原文 |
| 代码生成 | [code-generation.ts](code-generation.ts) | 根据规格实现模块，在容器中运行受保护测试 |
| 代码修改 | [code-modification.ts](code-modification.ts) | 基于固定源码版本修正逻辑，保存修改前后测试结果和新文件 |
| 测试执行 | [execution.ts](execution.ts) | 执行原始测试、应用候选修改、再次运行 Node 原生测试 |
| 故障诊断 | [diagnosis.ts](diagnosis.ts) | 根据实际测试失败、日志和源码定位问题，给出修复建议 |
| 代码审查 | [code-review.ts](code-review.ts) | 按规格检查逻辑、输入及溢出风险，标注准确源码行 |

## 运行

要求 Node.js 24+、Redis、Docker、ripgrep、Python 及 Matplotlib。模型凭据放在 `.env`，按 `ditto.yaml` 的 Provider 配置加载。依赖安装见[工具配置](../../_shared/tools/data-and-code/README.zh-CN.md)。

```sh
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
export DITTO_EXAMPLE_DATA_PYTHON="$PWD/examples/_shared/tools/.venv/bin/python"
docker pull node:24-bookworm-slim
npm run example:data-code:query
npm run example:data-code:cleaning
npm run example:data-code:exploration
npm run example:data-code:calculation
npm run example:data-code:visualization
npm run example:data-code:interpretation
npm run example:data-code:code-search
npm run example:data-code:code-generation
npm run example:data-code:code-modification
npm run example:data-code:execution
npm run example:data-code:diagnosis
npm run example:data-code:code-review
```

每个 CLI 创建 `.examples-data-code-tasks/cli-*`，生成独立的订单 CSV/数据库或代码样本。输入包含随机金额或测试数值；预期答案只由测试程序读取，不提供给模型。目录中保存 `request.json`、`snapshots/`、`memory.sqlite`、`effects/` 和 `output/`；这些产物不进入 Git。

```sh
node --env-file=.env examples/capabilities/data-and-code/query.ts --checkpoint
node --env-file=.env examples/capabilities/data-and-code/query.ts --directory /absolute/task-directory
```

`--checkpoint` 在工具执行结果持久化后停止。`--directory` 从已有请求恢复，不重新生成样本。每个任务 ID 绑定不可变请求；修改输入、规则或希望重新生成程序时使用新 ID。一个任务同时由一个控制器执行。

## 数据契约

订单字段为 `orderId,date,region,quantity,unitCents,status`；金额使用整数分，状态为 `paid/pending/refunded`。数量范围 0–1000，单价范围 0–100000000 分。日期采用有效的 `YYYY-MM-DD`，允许输入斜杠分隔日期。缺失地区填为 `Unknown`；缺失必要字段、无效日期、负数、非整数、超范围数值和未知状态剔除；重复 ID 保留第一条有效记录。清洗报告记录被剔除的 CSV 行号和原因。

查询、计算和解释针对已付款订单；图表分别展示三种状态的订单原始金额，不是扣除退款后的净收入。相关系数由有效清洗记录计算；常量列或样本不足以计算时返回 `null`，不会据此推断因果。应用工具独立核对生成程序与 SQL 的实际结果，不使用模型自报的“执行成功”。

此套业务工具演示固定订单表和规则；接入其他表、字段、计算口径或数据库时需替换应用适配器及其校验器。它不是对任意数据库开放的通用 SQL 代理。

## 代码契约

代码样本包含 `invoice.mjs`、`invoice.test.mjs` 和规格 README。工作流针对 `invoiceTotal(items)`：按数量乘单价求和，拒绝负数、非整数、不安全整数及乘加溢出，并保持输入不变。模型只可提交 `invoice.mjs` 的完整替换内容，并提供原文件 SHA-256；测试文件不能由模型修改。

原始输入保持可核对，候选代码写入 `output/invoice.mjs`。容器中的 Node 测试同时验证原始版本和候选版本；原始/修改后 TAP 日志、源码哈希与受保护测试哈希一起交付。诊断和审查只报告问题，不自动修改源码。示例的七项测试覆盖明确规格，不代表任意代码库、语言或全部边界情况已被证明正确。

## 恢复与交付

资料、计划、工具结果和解释分别通过 `MEMORY.WRITE` 保存。Redis 缓存缺失时从数据库 Memory 重建；连接故障直接报错。工具执行成功后写入按请求和计划指纹索引的应用回执，支持在工具完成而 Memory 尚未保存时恢复；报告交付前重新核对源码快照和产物哈希。

报告输出 `report.json`、`report.md`，并附 SQL、清洗 CSV、程序、图表、源码或 TAP 日志。JSON Pointer 证据值必须与实际工具结果一致；代码审查引用必须匹配原始文件的真实行。该检查保证来源可核对，不构成对所有自然语言结论的证明。已完成任务恢复时核对产物，不重复模型调用。交付是任务目录内文件写入，不会推送、部署或提交代码。

## 验收

```sh
npm run check:examples:data-code:tasks
npm run check:examples:data-code:tasks:package
```

包验收在仓库外安装实际 npm tarball，无源码回退或 TypeScript paths 别名；检查公开导入边界、严格类型及十二个入口的无副作用导入。实验从真实 CSV/SQLite/源码开始，使用真实模型、Redis、SQLite、Docker、ripgrep 和 Matplotlib，核对实际查询、计算、修改、测试及交付文件。覆盖十二项能力及缓存过期、存储故障、坏输入、越权 SQL、受保护测试、错误结果引用、代码超时、文件篡改和进程中断恢复。SQLite 验收不等于其他数据库验收。

## Graph / Loop 组合

本模块在 `shared.ts` 导出完整任务的 `run*Loop`。`run*()` 入口只调用一次 `runtime.loop()`，阶段 Graph 通过执行计划交给 Loop 统一调度；子计划复用同一个 1024 次 Graph 执行预算，检查点恢复、分支和重复不会另起调度器。Graph 内保留节点依赖，资料、模型和业务操作仍经过公开 Worker。详见 [Graph / Loop API](../../../docs/worker-api/graph-loops.zh-CN.md)。
