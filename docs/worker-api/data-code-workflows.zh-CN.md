# 数据与代码能力的公开 API 组合

[English](data-code-workflows.md) · [十二项示例](../../examples/capabilities/data-and-code/README.zh-CN.md)

这些流程复用已导出的 Runtime、Graph、Context、Memory、Infer 和 Interaction 接口。模型生成 SQL、程序或代码修改方案；应用工具负责实际执行、业务核对与文件交付。不需要新增与某个数据库、绘图库或代码语言绑定的 Core 节点。

| 阶段 | 公开调用 | 输入/输出 |
| --- | --- | --- |
| 恢复 | `MEMORY.GET` | 按任务键读取请求指纹及检查点 |
| 获取资料 | `INTERACTION.ACT.TOOL` → `INTERACTION.OBSERVE` | 原始 CSV、表结构、源码快照 |
| 保存与组装 | `MEMORY.WRITE`、`CONTEXT.LOAD` | 持久化资料并建立 Redis 会话 |
| 制订方案 | `INFER.REASONING.SAMPLE` | 生成结构化工具选择、SQL、函数体或候选模块 |
| 执行 | `INTERACTION.ACT.TOOL` → `INTERACTION.OBSERVE` | 真实查询、容器执行、检索、绘图或测试结果 |
| 解释 | `CONTEXT.LOAD`、`INFER.REASONING.SAMPLE` | 根据实际结果与可引用值目录生成结论 |
| 交付 | `MEMORY.WRITE`、`INTERACTION.ACT.TOOL` | 校验证据、写入并核对报告及产物 |

## 消费端接入

消费项目安装 `@ditto/core`、Redis SDK，并复制 `examples/capabilities/data-and-code`、`examples/_shared/tools/data-and-code`、`execution` 和 `storage` 应用目录。示例代码和第三方执行环境不包含在 Core npm tarball 内。依赖安装及 Docker 配置见[工具说明](../../examples/_shared/tools/data-and-code/README.zh-CN.md)。

将下面代码保存为消费项目根目录的 `data-code-app.ts`：

```ts
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { dataCodeTools } from "./examples/_shared/tools/data-and-code/tools.ts";
import { resumeFixture } from "./examples/_shared/tools/data-and-code/fixtures.ts";
import { sandbox, model, toolConfig } from "./examples/capabilities/data-and-code/cli.ts";
import { runDataCode } from "./examples/capabilities/data-and-code/shared.ts";

const directory = resolve(process.argv[2]!);
const request = await resumeFixture(directory);
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const storage = await openAgentStorage(directory, config);
try {
  const runtime = createDitto({
    config,
    sandbox: sandbox(config, request),
    workers: [
      ...storage.workers,
      createInferWorker(),
      createInteractionWorker({
        tools: dataCodeTools(directory, request, toolConfig()),
      }),
    ],
  });
  try {
    const result = await runDataCode(runtime, { request, model: model(config) });
    console.log(JSON.stringify(result));
  } finally {
    await runtime.close();
  }
} finally {
  await storage.close();
}
```

```sh
node --env-file=.env data-code-app.ts /absolute/task-directory
```

`runDataCode(runtime, input, options)` 是应用组合函数，不是新增 Core 导出。各能力入口的 `run` 额外核对 `request.mode`。`input.model` 使用公开 `ModelConfig`；`options` 支持 `signal` 及 `stopAfter: "material" | "plan" | "outcome" | "interpretation"`。

请求包含 `id`、`tenant`、`mode`、`instruction` 和 `sources: {path,sha256}[]`。示例输入固定为订单 CSV/独立业务 SQLite，或包含模块、受保护测试与规格的源码目录。调用者可以替换其数据，但更换表结构、代码接口或业务规则时应同步修改应用工具和校验器。源码候选仅写入任务输出，不直接改动已有用户仓库。

## 工具与证据

方案为 `{tool,arguments}`。工具名受当前模式允许列表约束；参数与源码基线哈希在执行前验证。虽然方案由普通 JSON 模型输出承载，执行仍经过公开 `INTERACTION.ACT.TOOL`、工具注册表和 Sandbox，不在模型回调中直接执行 Worker。

执行结果包含 `tool/result/evidence/files`。业务结果独立核对后才写入 Memory；副作用回执保存于应用 `effects/`，供“工具成功但结果尚未写入 Memory”的恢复使用。数据库 Memory 保存的是 Agent 检查点，不由业务数据库或文件回执替代。

解释结果包含 `summary/insights/issues/limitations`。`insights` 只能引用应用从真实 `result` 枚举出的短标量值，通过 JSON Pointer 和精确值比较验证；较长日志保留为 TAP 文件，不要求模型重新输出整段日志。代码问题必须给出真实源码路径、1-based 行号、精确行文本、严重性、原因与建议。

引用检查验证来源和数值一致性，不能证明所有自然语言判断。代码测试和业务规则覆盖范围详见[示例契约](../../examples/capabilities/data-and-code/README.zh-CN.md)。

## 存储、失败与恢复

Context 使用 Redis；数据库 Memory 默认为文件 SQLite，也可由消费端替换为公开 `MemoryStore` 适配器。缓存过期时从 Memory 重建，连接失败不静默切换到本地内存。请求指纹防止同一 ID 下替换需求或源版本。模型输出被截断、引用无效、SQL 越权、代码超时、测试失败或产物哈希变化都会终止该次执行。

示例不会自动批准失败候选、修改受保护测试或绕开校验。需要调整方案时由可信控制器创建新的任务请求；无需重新推理的完整检查点可以恢复。单任务单控制器运行，目录内文件交付不表示已获得外部发布或合并授权。

## 发布边界验收

```sh
npm run check:examples:data-code:tasks:package
```

该命令实际打包并在仓库外安装 Core，复制应用工具，进行无别名严格类型检查和私有导入拦截，随后运行真实任务实验。源码不在安装包内，Python/容器是应用依赖，所有 Worker 都通过公开 Runtime 调度。
