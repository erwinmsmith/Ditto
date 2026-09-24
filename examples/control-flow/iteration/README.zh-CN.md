# 2.4 循环与动态调整

[English](README.md) · [控制流程](../README.zh-CN.md) · [全部示例](../../README.zh-CN.md)

用 Ditto 公开 Graph、Loop、INFER 和 INTERACTION API 完成一份发布简报：读取实际资料，积累证据，修订已有草稿，由确定性检查器逐项验收并保存文档。业务文件工具位于 [brief-files.ts](../../_shared/tools/brief-files.ts)，仅依赖 Node.js 标准库。

## 六类流程

| 流程 / 文件 | 入口 | 执行行为 |
| --- | --- | --- |
| [循环执行](bounded-loop.ts) | `runBounded` | 重复同一个修订 Graph，每轮处理一个未通过的字段，保存后检查退出条件 |
| [动态重规划](adaptive-loop.ts) | `runAdaptive` | 模型读取最新检查结果提出下一步；Loop 按验证后的计划切换规划、检索或修订 Graph，失效来源会触发备用来源计划 |
| [迭代改进](improvement.ts) | `runImprovement` | 对已有草稿逐项检查和修改，保存每版文档，保留已经正确的字段 |
| [迭代检索](retrieval.ts) | `runRetrieval` | 根据缺失字段和已尝试来源继续检索；证据齐全后生成并验收最终简报 |
| [目标检查](goal-check.ts) | `runGoalCheck` | 执行前及每轮保存后检查实际字段和来源；已有合格文档直接返回，最后一个缺陷修复后立即结束 |
| [停止条件检查](stop-conditions.ts) | `runStopConditions` | 按目标、来源状态、轮数及模型调用预算决定继续或停止，保留部分成果和明确的停止原因 |

[shared.ts](shared.ts) 包含修订、规划、检索 Graph 与状态校验；六个入口保留各自的 Loop 编排。[cli.ts](cli.ts) 负责配置和 Runtime 生命周期，[fixtures.ts](fixtures.ts) 创建可独立读取的随机任务材料。导入模块不会执行任务。

## 运行

需要 Node.js 24+、npm 11+。运行 `npm ci`，按[配置文档](../../../docs/worker-api/configuration.zh-CN.md)准备 `.env` 中的 Provider 凭据、模型及网络白名单。命令显式加载 `ditto.yaml` 和 `.env`，调用实际 HTTP 模型。

```bash
npm run example:iteration:bounded
npm run example:iteration:adaptive
npm run example:iteration:improvement
npm run example:iteration:retrieval
npm run example:iteration:goal
npm run example:iteration:stop -- --model-call-budget 1
```

默认材料包含发布编号、负责人和截止日期三个字段。普通循环从空草稿开始；改进流程从三个错误字段开始；目标检查流程只有一个字段待修复；动态流程的第一份来源不存在，模型必须根据实际失败重新规划。停止条件 CLI 默认预算为一次 Sample 调用，因此会产生部分简报；使用 `--model-call-budget 3` 可完成默认任务。

自定义输入：

```bash
npm run example:iteration:adaptive -- --input /absolute/path/release-input --max-rounds 24 --model-call-budget 12
```

输入目录包含 `spec.json` 和 `<sourceId>.json`。例如：

```json
{
  "required": ["code", "owner"],
  "catalog": [
    { "id": "release", "fields": ["code"] },
    { "id": "team", "fields": ["owner"] }
  ],
  "initialDraft": { "owner": "previous-team" },
  "initialEvidence": []
}
```

`release.json` 为 `{"facts":{"code":"REL-731"}}`，`team.json` 为 `{"facts":{"owner":"platform-team"}}`。这些文件是应用信任的权威数据，检查器对精确字段值负责；该示例的验收标准是结构化事实一致性。

普通循环、迭代改进、目标检查和停止条件的修订步骤要求证据已经导入：在 `initialEvidence` 中列出覆盖全部目标字段的来源 ID。动态重规划和迭代检索可以从空证据开始。来源目录顺序定义查找优先级，每个“字段、来源”组合最多尝试一次。字段最多 16 个，来源最多 32 个，来源文件最多 1 MiB；ID 使用小写字母开头的字母、数字或连字符，值为非空单行字符串。

## 结果与停止语义

所有入口为 `runX(runtime, input, options?)`：

- `runtime`：调用方创建的 `Pick<DittoRuntime, "run" | "loop">`，由调用方关闭。
- `input`：`{ model, maxRounds?, modelCallBudget? }`；两个上限默认 24，接受 0–100 的整数。
- `options`：`{ signal?: AbortSignal }`，传入每次 Graph 和 Loop 执行。
- 返回 `BriefReport`：`{ status, reason, rounds, modelCalls, snapshot }`；snapshot 包含草稿、证据与 SHA-256、检索记录、修订号、缺失证据和未通过字段。

停止优先级为：目标完成 `goal` → 缺失字段已无可尝试来源 `blocked` → 轮数耗尽 `round-limit` → 下一轮模型调用额度不足 `budget`。仅 `goal` 的 status 是 `completed`，其他情况均为 `stopped`。空目标或已完成目标可以在零预算、零轮数下完成。证据齐全但文档尚未生成时仍未完成目标。

一轮等于一次 Loop Graph 执行；动态流程的规划、检索和修订分别计轮。检索流程的最终生成也计一轮。预算计数单位是 `INFER.REASONING.SAMPLE` 节点：规划和修订各一次，独立文件检索为零次。执行前检查下一轮需要的额度，因此已经规划好的零模型调用检索可继续；预算不代表 token、金额或 Provider 内部重试次数。

`maxIterations` 保留为 Core 硬性保护；应用通过 `done` 返回正常停止状态。若应用一直不返回 done，原生 Loop 仍抛出 `Loop iteration limit reached`。外部取消、工具失败、无效计划、模型失败或截断响应会拒绝执行，不生成正常完成报告；已保存修订保留。模型自报完成不会改变确定性检查结果。

## 文件产物

每次 CLI 创建 `.examples-iteration-tasks/cli-*/input/` 和全新的 `output/`：

```text
output/
├── spec.json                 # 本次验收字段及来源目录
├── state.json                # 草稿、证据、检索尝试和修订号
├── revisions/0.json          # 原始草稿
├── revisions/1.json          # 每次实际修订
├── rounds/1.json             # 每轮检查结果、计划和累计模型调用数
├── brief.md                  # 完成或部分完成的简报
└── result.json               # 最终检查结果与停止原因
```

使用新的输出目录启动任务；已有目录会被拒绝，避免并发任务覆盖。状态 JSON 用临时文件与 rename 更新，每轮记录不覆盖写入。每次检查重新读取证据来源，SHA-256 或值变化会使任务失败。进程结束后可以重新创建文件适配器并读取检查产物。

## 任务级端到端实验

```bash
npm run check
npm run check:examples:iteration:tasks
npm run check:examples:iteration:tasks:package
npm run check:examples:iteration:tasks:package -- --provider deepseek
```

17 个实验覆盖六个流程，以及备用来源重规划、已有目标、空目标、预算和次数的零值/非零边界、无来源状态、实际文件缺失、证据齐全但未生成文档、动态预算边界、原生硬性上限与执行前取消。测试从随机实际文件开始，调用真实模型和文件工具，检查轮次、计划变更、草稿差异、来源哈希、最终文档；Runtime 关闭后重新读取结果。

包实验在仓库外安装 npm tarball，使用严格 NodeNext 类型检查，无源码 paths 别名；验证六个模块导入无副作用，然后执行同一组真实任务。模型和工具不使用替身。离线回归另行覆盖错误模型值、无效计划、截断响应、Provider 失败、执行中取消及来源变更。

产物保存在 `.examples-iteration-tasks/run-*/`。报告为 `.examples-iteration-tasks-live-results.json` 或 `.examples-iteration-package-live-results.json`，记录 Provider/model、每个真实 Worker 调用的 Graph/node/run ID、时间、模型 usage 和实验结果。断言失败时退出码非零。

完整调用示例及 Loop API 语义见[循环与动态调整 API 用法](../../../docs/worker-api/iteration.zh-CN.md)。
