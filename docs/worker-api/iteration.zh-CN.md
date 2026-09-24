# 循环与动态调整：公开 API 用法

[English](iteration.md) · [Runtime](runtime.zh-CN.md) · [六类示例](../../examples/control-flow/iteration/README.zh-CN.md)

循环流程复用 `graph`、`loop`、`runtime.run`、`runtime.loop` 及内置 INFER/INTERACTION Worker。规划验证、文件检索、草稿修订、验收规则和预算计数都属于应用逻辑，通过公开接口组合。

## 应用调用

在安装 `@codesoul-co/ditto` 的应用中，复制 `examples/control-flow/iteration/` 和 `examples/_shared/tools/brief-files.ts`，保留相对路径。准备 `ditto.yaml`、`.env` 和[输入目录](../../examples/control-flow/iteration/README.zh-CN.md#运行)，然后执行：

```ts
import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { createBriefFiles } from "./examples/_shared/tools/brief-files.ts";
import { runAdaptive } from "./examples/control-flow/iteration/adaptive-loop.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure the model");
const directory = await mkdtemp(join(tmpdir(), "release-brief-"));
const files = createBriefFiles({
  inputDirectory: resolve("release-input"),
  outputDirectory: join(directory, "output"),
});
const runtime = createDitto({
  config,
  sandbox: { ...config.sandbox, tools: files.tools.map(tool => tool.name) },
  workers: [createInferWorker(), createInteractionWorker({ tools: files.tools })],
});
try {
  const report = await runAdaptive(runtime, {
    model: config.model, maxRounds: 24, modelCallBudget: 12,
  }, { signal: AbortSignal.timeout(180_000) });
  console.log(report.status, report.reason, files.directory);
} finally { await runtime.close(); }
```

Node.js 24+ 使用 `node --env-file=.env app.ts`；TypeScript 使用 NodeNext 解析，无需源码 paths 别名。`runAdaptive` 等六个函数是应用示例入口；Core 包导出编排和 Worker 接口。展开 `config.sandbox` 保留模型 Provider 的网络权限，应用显式注册文件工具。

`runBounded`、`runAdaptive`、`runImprovement`、`runRetrieval`、`runGoalCheck`、`runStopConditions` 共用签名：

```ts
(runtime: Pick<DittoRuntime, "run" | "loop">,
 input: { model: ModelConfig; maxRounds?: number; modelCallBudget?: number },
 options?: { signal?: AbortSignal }) => Promise<BriefReport>
```

两个应用上限默认 24，均接受 0–100 的整数。`BriefReport` 为 `{ status: "completed" | "stopped", reason: "goal" | "blocked" | "round-limit" | "budget", rounds, modelCalls, snapshot }`。snapshot 保存所需字段、来源目录、草稿、证据值/来源 ID/SHA-256、检索尝试、修订号、缺失字段和检查结果。

## Loop 的调用顺序

```ts
const definition = loop({
  graph: (state: State) => chooseGraph(state),
  maxIterations: 24,
  bind: (state: State) => ({ state, model }),
  update: (state, output): State => nextState(state, output),
  done: (updatedState, output) => shouldStop(updatedState, output),
});
const finalState = await runtime.loop(definition, initialState, {
  signal,
  concurrency: 1,
  workers: { "brief-search": { searched: "interaction-worker" } },
});
```

`chooseGraph`、`nextState`、`shouldStop` 由应用实现；图、状态类型和模型配置保持一致。`workers` 可选，按 Graph ID、节点 ID 映射到实际注册 Worker ID。

每轮顺序为：Graph 选择 → bind → 等待整个 Graph → update → done。bind、选择函数、update、done 都是同步函数；文件读取、异步判断和持久化放入图中的工具节点。done 收到更新后的状态和本轮输出。不同候选 Graph 必须满足相同输入/输出契约；示例用共同的 recorded 输出提取经检查的状态。

Loop 至少运行一次，所以零预算、零轮数、空目标和已完成目标在调用前检查。原生 maxIterations 必须是正安全整数；定义值优先于配置 `runtime.loopMaxIterations`，最终默认 32。达到上限但 done 仍为 false 会抛错。示例让 done 在业务轮数耗尽时返回 true，并用 reason 标记正常停止，原生上限继续作为保护。

运行选项的 signal 传给每轮 Graph，并在轮次边界检查；抛错退出时不执行后续轮次。`concurrency` 限制每一轮 Graph 的活动节点数，Loop 的轮次本身顺序执行。Loop 状态属于调用端，应用通过工具保存文件记录。

## 动态计划与验收

模型计划只有两类：

```json
{ "kind": "search", "field": "code", "sourceId": "release" }
```

```json
{ "kind": "repair", "field": "code" }
```

search 必须针对缺失证据，从目录中选择覆盖该字段且尚未尝试的来源；repair 必须针对未通过检查且已有证据的字段。模型不能指定路径或任意操作。应用验证后写入 rounds，并在下一轮通过 `graph(state)` 选择原生 Graph。检索失败记录 found:false，新的规划输入包含失败尝试与剩余来源。修订模型返回 `{ patches: { field: value } }`，必须恰好覆盖本轮请求字段。

每次保存草稿后重新读取文件与来源哈希。检查器只在所有字段都有有效证据且草稿值完全一致时给出 complete:true。修订可先保存错误值，后续检查保留问题并继续迭代，直到通过或达到停止条件；模型自评不参与验收。

迭代检索按缺失字段查询本地结构化资料目录，属于应用 RegisteredTool 的精确查询。使用向量库或搜索服务时可以替换该工具的实现；Core 的 [CONTEXT.SELECT / RAG](context.zh-CN.md) 提供上下文检索组合接口。

## 应用工具配置

`createBriefFiles({ inputDirectory, outputDirectory })` 返回 `{ tools, directory, inspect }`，无隐式连接、Core 配置项或额外运行依赖。输出目录的父目录需存在，outputDirectory 本身由 brief_open 排他创建。

| 工具 | 参数与作用 |
| --- | --- |
| brief_open | `{}`；读取并校验 spec.json，导入 initialEvidence，保存初始状态和原始草稿 |
| brief_search | `{ field, sourceId }`；读取目录内来源，记录成功或缺失；成功时保存字段证据及 SHA-256 |
| brief_patch | `{ patches: { field: value } }`；只修改当前未通过且有证据的字段，递增修订号并保存 |
| brief_check | `{}`；重新读取状态和证据来源，计算 missing、issues、complete、blocked |
| brief_record | `{ round, action, modelCalls, next }`；next 为已验证计划或 null，保存不可覆盖的轮次检查记录 |
| brief_finish | `{ reason, rounds, modelCalls }`；再次检查实际文件，保存 brief.md 和 result.json |

工具通过 `INTERACTION.ACT.TOOL` 执行，返回 ExternalResult。Graph 绑定函数显式检查其 status；模型节点还检查 NodeResult.status、finishReason、消息类型、JSON 及允许的动作/字段。工具或模型错误拒绝执行，已存在的轮次和修订可用于排查。

## 预算与停止优先级

应用先判断 goal，再判断 blocked、round-limit、budget。仅 goal 表示完成；blocked 表示至少一个缺失字段没有剩余来源。有限预算计 Sample 节点调用次数，执行前保留下一轮所需额度。规划和修订各消耗一次，独立文件检索为零；该计数不涵盖 Provider 内部 HTTP 重试、token 或货币。

所有 Graph 执行轮次计入 maxRounds，包括动态规划和检索后的最终生成。证据齐全只是检索阶段的退出条件，文档仍须生成并通过最终验收；预算在两阶段间耗尽时返回 stopped/budget。

实际命令、材料结构和 17 项真实任务验收见[示例说明](../../examples/control-flow/iteration/README.zh-CN.md)。`npm run check:examples:iteration:tasks:package` 验证独立安装后的公开 API、真实模型、文件工具、任务产物和停止行为。
