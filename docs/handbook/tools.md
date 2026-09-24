# Tool：定义、选择、执行与观察

普通工具是应用提供的 `RegisteredTool`。数据库 SDK、CRM、文件、浏览器等都可以由它封装；Ditto 负责通过 `INTERACTION.ACT.TOOL` 路由、检查注册名权限、校验结果，再通过 OBSERVE 转为可继续推理的信息。

## 1. 安装和第一次执行

这一例子只需要主包，统计 Unicode 字符数量：

```sh
node examples/package-basics/tools.ts 'A😀'
```

预期字符数为 2。完整代码可复制为应用模块：

<<< ../../examples/package-basics/tools.ts

Tool 不是新的 Node 类型。所有普通工具共用 `INTERACTION.ACT.TOOL`，具体实现通过 `name` 选择。新增 CRM 工具通常不需要修改框架或添加 `CRM.UPDATE`。

## 2. 工具实现的三个部分

| 部分 | 职责 |
| --- | --- |
| name / description / inputSchema | 供调用者和模型理解用途及参数 |
| validate(arguments) | 真正的运行时校验，不因为提供 JSON Schema 就省略 |
| execute(arguments, context) | 完成业务动作并返回 ToolExecutionOutcome |

输入参数是 JSON 对象。输出不要带函数、Date、BigInt、数据库连接或原始 Error。日期先转 ISO 字符串；二进制或大文件使用经过授权的引用。

工具成功返回 `content`、`structuredContent`、`references` 中至少一种。失败可以返回安全的结构化 error；callId 和 source 由 Registry 绑定到原始请求。应用应区分失败、取消、超时和 unknown。

## 3. 注册与允许调用是两件事

```ts
const runtime = createDitto({
  sandbox: { tools: ["lookup_order"] },
  workers: [createInteractionWorker({ tools: [lookupOrder] })],
});
```

`lookupOrder` 是应用已经实现的 RegisteredTool。注册并不自动授权，允许名称也不自动创建工具。ToolRegistry.list 只向当前执行上下文展示允许的工具。

`requiresApproval`、`effects` 是描述信息，不会自动弹出审批 UI。由可信应用控制器检查审批记录，并在图中把确认结果作为执行前置条件。不能相信模型自己生成的“已获得批准”。

## 4. 一条工具链如何构图

```text
输入 → lookup_customer → OBSERVE ─┐
输入 → lookup_order → OBSERVE ────┴→ 分析状态
                                       ↓
                                检查权限与幂等
                                       ↓
                                 update_crm
                                       ↓
                              OBSERVE → OUTPUT
```

独立读取可以并行。写入依赖校验结果；下一步之前检查 ExternalResult.status。完整示例：[串行、并行和条件工具链](../../examples/patterns/tool-chain/README.zh-CN.md)。

参数补全由模型/应用根据当前上下文完成，但还需要工具的 schema 与业务校验。不要直接执行模型生成的任意命令字符串；命令工具应使用允许命令、参数数组及受限执行器。

## 5. 与模型形成闭环

[工具选择示例](../../examples/capabilities/tools/selection.ts)展示模型从允许工具中选择；[参数补全](../../examples/capabilities/tools/parameters.ts)展示根据真实上下文构造业务 API 请求。两者通过 Redis Context、数据库 Memory 和实际服务响应完成任务。

Loop 每轮得到模型的动作请求后，检查 action name 是否属于本轮已公布的集合；有副作用的动作还要检查身份、目标对象状态和幂等键。结果经 OBSERVE 保留 callId、source、status，再显式 UPDATE 到工作上下文。

OBSERVE 不执行重试，也不自动更新 Context。将失败观察保留给下一轮推理是应用决策，不要把失败消息重新包装成 success。

## 6. 文件、命令和网络

- 文件工具可调用 `ctx.services.sandbox.readText/writeText`，在配置的 workspace 中受 read/write 与路径检查约束。
- 命令工具需要显式注入 SandboxExecutor。`createLocalSandboxExecutor` 是本地进程执行；对于不可信代码需要容器或 OS 级隔离。
- HTTP 工具要限制允许的地址、响应体大小和超时，校验状态码与业务字段，并传递 `ctx.signal`。
- 第三方 SDK 直接调用不自动受 Sandbox 的网络规则约束；适配器必须落实该边界。

Sandbox 是合作式能力检查，不是任意 JavaScript 的操作系统沙箱。详见 [Runtime/Sandbox](../worker-api/runtime.zh-CN.md)。

## 7. 重试和交付

“客户端超时”不等于“服务器未写入”。写操作使用稳定幂等键，重试前查询外部系统是否已生效。OutputSink 的 accepted 表示接收，不表示邮件已读或远端任务已经成功；有业务确认要求时增加核对步骤。

[完整 INTERACTION API](../worker-api/interaction.zh-CN.md) · [十类系统操作](../../examples/capabilities/tools/README.zh-CN.md) · [异常恢复](reliability.md)
