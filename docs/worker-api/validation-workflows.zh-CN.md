# 验证、评估与安全 API 组合

[九项示例](../../examples/capabilities/validation/README.zh-CN.md) 使用已发布形状的公开入口。此流程无需新增 Core 节点：业务权限、评分标准和脱敏规则位于应用工具目录，Core 提供组装、调度、模型调用、存储和工具访问边界。

| 阶段 | 公开调用 | 应用责任 |
| --- | --- | --- |
| 读取输入 | `INTERACTION.ACT.TOOL` → `INTERACTION.OBSERVE` | `validation_source` 限制输入大小和结构、核对哈希、脱敏，不返回原值 |
| 检查点 | `MEMORY.GET` / `MEMORY.WRITE` | 请求指纹、脱敏材料、合法评估和报告；适配器使用持久 SQLite |
| 上下文 | `CONTEXT.LOAD`，显式 `scope` | Redis；仅对 `CONTEXT_NOT_FOUND` 从持久材料重建 |
| 质量评估 | `INFER.REASONING.SAMPLE` | 固定三维评分标准；引用必须与提供的路径和原文完全相同 |
| 发布门禁 | `INTERACTION.ACT.TOOL` → `INTERACTION.OBSERVE` | `validation_commit` 重新读取源数据、验证评估、事务内检查实时业务策略并写入 |
| 结果交付 | `MEMORY.WRITE` | 实际发布回执、脱敏 JSON 报告路径与 SHA-256 |

## 完整调用

以下代码保存为消费者应用根目录的 `validation-example.ts`。从本仓库复制 `examples/capabilities/validation`、`examples/_shared/tools/validation`、`examples/_shared/tools/storage`、`examples/_shared/tools/execution/files.ts`；安装 `@codesoul-co/ditto` 的构建包及 Redis 适配器依赖，提供 `ditto.yaml` 和环境变量。源代码不依赖 Core 的内部路径。仓库内可直接运行同样的文件。

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { openValidationTools } from "./examples/_shared/tools/validation/tools.ts";
import { createFixture } from "./examples/_shared/tools/validation/fixtures.ts";
import { model, sandbox } from "./examples/capabilities/validation/cli.ts";
import { run } from "./examples/capabilities/validation/risk.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
await mkdir(".examples-validation-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-validation-tasks/api-"));
const request = await createFixture(directory, "risk");
const storage = await openAgentStorage(directory, config);
try {
  const business = openValidationTools(directory, request);
  try {
    const runtime = createDitto({
      config,
      sandbox: sandbox(config, request),
      workers: [
        ...storage.workers,
        createInferWorker(),
        createInteractionWorker({ tools: business.tools }),
      ],
    });
    try {
      const pending = await run(runtime, { request, model: model(config) });
      if (!("receipt" in pending)) throw new Error("Expected completed review");
      console.log(pending.receipt); // confirmation-required; no publication
      // Only call after the host authenticates an authorized reviewer and
      // receives their explicit approval for this exact assessment and target.
      // await business.approve(pending.assessment, "trusted-reviewer");
      // const published = await run(runtime, { request, model: model(config) });
    } finally {
      await runtime.close();
    }
  } finally {
    business.close();
  }
} finally {
  await storage.close();
}
```

```sh
node --env-file=.env validation-example.ts
```

## 请求与结果

`Request` 为 `{ id, tenant, mode, sourceHash }`。`id`、`tenant` 使用受限标识符，`sourceHash` 为 `source.json` 原始字节的 SHA-256。请求不接收自由文本指令、授权标志、工具名或任意文件路径。源文件由工具关闭在任务目录内，校验大小、符号链接和内容摘要。CLI 使用合成材料；生产应用应实现自己的可信输入接收流程。

`runValidation(runtime, input, options)` 和九个入口的 `run` 返回：

- `{ status: "checkpoint" }`：`stopAfter` 指定 `material` 或 `assessment`。
- `Report`：包含 `taskId`、`mode`、`material`、`assessment`、`receipt`、`file`、`sha256`。
- `material.findings`：仅 `{ path, kind }`；`checks` 包含明确要求、数值冲突和输入模式检查。
- `assessment.dimensions`：完整性、相关性、清晰度各一个 0–4 整数分数、理由及精确引用；低于 2 分拒绝发布。模型结果结构、引用或脱敏检查失败会抛错，不保存该评估。
- `receipt.status`：`published`、`denied` 或 `confirmation-required`。`reasons` 为业务规则代码，`policyRevision` 为判定使用的修订号，`payloadHash` 为脱敏文档摘要，只有已发布时才有 `effectId`。

模式切换必须创建新任务。重试相同请求复用数据库评估，但重新检查输入和策略。已提交记录返回原回执；不同判定报告以内容哈希命名，不覆盖历史文件。

## 可信控制器与工具边界

`openValidationTools(directory, request)` 返回 `tools`、`current()`、`setPolicy(policy)`、`approve(assessment, actor)`、`countEffects()`、`close()`。仅 `tools` 注册到 Interaction Worker。

`Policy` 包含 `revision`、`actor`、`tenant`、`role: "publisher" | "reader"`、`targetTenant`、`target`、`affected`、`reversible`、`enabled`、`maxAffected`。修订必须递增。所有字段来自可信业务状态；未知字段、未知可逆性、非法数值拒绝，不给默认允许值。身份认证由宿主实现，示例的 `trusted-reviewer` 是受限的控制器身份示意，不是凭字符串完成的生产认证。

批准绑定请求、脱敏文档、评估以及整个策略对象。目标、权限或策略修订变化后需要重新批准。用户文本、模型输出以及 `requiresApproval` 标记都不能创建批准。`requiresApproval` 是工具元数据，Core 不自动暂停或显示审批界面。

工具名由 Graph 固定，`sandbox.tools` 只允许 `validation_source` 和 `validation_commit`。适配器使用应用数据库客户端完成真实写入，业务规则必须在适配器内落实；Sandbox 不能隔离任意应用 JavaScript。本示例没有任意 SQL、命令、网络发送或授权管理工具。

## 安全与存储边界

数据流为原始文件 → 适配器内结构验证与脱敏 → Runtime / Context / Memory → 模型评估 → 事务门禁 → 脱敏发布记录及报告。原始文件不属于脱敏输出，须独立保护和清理。识别范围见 [示例说明](../../examples/capabilities/validation/README.zh-CN.md#检测范围)，不能将有限模式规则当作完整 DLP 或提示注入检测。

缓存缺失、服务不可用、用户取消、模型输出不合法及业务拒绝是不同结果。业务拒绝有可交付报告；基础设施或数据完整性错误直接失败。`signal` 通过 `runtime.run` 传递。已提交副作用无法由取消撤销；恢复通过业务幂等记录确认实际结果。

执行 `npm run check:examples:validation:tasks:package` 验证 npm 消费者、真实模型、Redis、独立 SQLite Memory 与发布数据库、产物内容和跨进程恢复。测试夹具中的 Worker 包装仅用于观测、故障注入和 SIGKILL，不是应用调用模式。

报告检查点使用 `report:<sha256>` 作为阶段键，以 `MEMORY.WRITE` 追加保存每次判定，保留待确认与批准后的历史。
