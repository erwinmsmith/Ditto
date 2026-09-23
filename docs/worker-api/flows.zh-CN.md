# 预定义流程 API

[English / 简体中文](flows.md) · [Runtime](runtime.zh-CN.md) · [API](README.zh-CN.md)

这些函数从 `@ditto/core/runtime` 导出，组合已有公开节点。完整代码见 [flows.ts](../../examples/runtime/flows.ts)。运行 `npm run example:runtime:flows` 会执行 Skill、文本 RAG 和真实 README 工具读取；MCP/ReAct 函数需要调用者提供已连接客户端或模型配置，不会自动运行。

## Context 流程

前四个函数签名均为 `(runtime: RuntimeClient, input) => Promise<...>`，只有两个参数。RuntimeClient 要实现 invoke/emit，可传 DittoRuntime 或 WorkerContext。它们使用显式 Context，不自动保存 session 缓存；需要缓存时使用带 scope 的 CONTEXT 节点。

| API / 输入 | 输出与调用链 |
| --- | --- |
| `runRagFlow(runtime, {context,query?,corpus?,limit?,maxTokens?,options?})` | `{output:ContextSelection,context:output.context}`；SELECT purpose=infer，strategy.kind=rag；需已注入 ragStrategy |
| `runSkillFlow(runtime, {context?,sources})` | `{output:Context,context}`；LOAD sources，有 context 再 UPDATE 合并；sources 为已解析 ContextSource[] |
| `runToolCallFlow(runtime, {context,call})` | `{output:ExternalResult,observation,context}`；TOOL → OBSERVE → UPDATE |
| `runMcpFlow(runtime, {context,request:{operation:"discover",server?}})` | `{output:{operation:"discover",capabilities},context}`；只发现，不生成 observation、不修改 context |
| `runMcpFlow(runtime, {context,request:{operation:"invoke",server,call}})` | `{output:{operation:"invoke",result},observation,context}`；MCP → OBSERVE → UPDATE；校验 callId |

query/content 使用 MessageContent，corpus 使用 Reference，options 为 JsonObject；limit/maxTokens 为可选预算，具体校验见 CONTEXT。call 为 `{id,name,arguments}`，arguments 必须是 JSON 对象。工具、MCP 客户端和相应 Sandbox 权限必须在执行端配置。业务 failed 结果仍可经过 OBSERVE 写入 Context，调用方自行判断是否继续；基础设施异常直接拒绝。

Skill 流程不下载、扫描或执行 SKILL.md，也不隐式检查 skills 权限。应用解析 sources，并在自己的解析/执行边界调用 sandbox.assert("skills", name)。默认 CONTEXT.LOAD 保存 Reference，不自动读取其目标；需要引用解析时显式使用 LOAD 的 resolveReferences 与 resolver。

以下是完整示例的导入和工具定义：

```ts
import assert from "node:assert/strict";
import type { Context, ToolCall } from "@ditto/core/contracts";
import type { RuntimeClient } from "@ditto/core/worker";
import { createContextWorker, createRagStrategy } from "@ditto/core/worker/context";
import { createInteractionWorker, type RegisteredTool } from "@ditto/core/worker/interaction";
import type { ModelConfig } from "@ditto/core/worker/infer";
import {
  createDitto, runMcpFlow, runRagFlow, runReactFlow, runSkillFlow, runToolCallFlow,
  type DittoRuntime,
} from "@ditto/core/runtime";
```
```ts
export const readTextTool: RegisteredTool = {
  name: "read_text", description: "Read a workspace text file", effects: ["read"],
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  validate(args) { if (typeof args.path !== "string") throw new TypeError("path must be a string"); },
  async execute(args, ctx) {
    return { status: "success", content: await ctx.services.sandbox.readText(args.path as string, ctx.signal) };
  },
};
```

```ts
export async function contextFlows() {
  const runtime = createDitto({
    sandbox: { read: true, tools: ["read_text"] },
    workers: [
      createContextWorker({ services: { ragStrategy: createRagStrategy({ retrieve: {
        async retrieve({ items, query }) {
          if (typeof query !== "string") throw new TypeError("This retriever accepts text queries");
          return items.filter(item => typeof item.content === "string"
            && item.content.toLowerCase().includes(query.toLowerCase())).map(item => ({ item }));
        },
      } }) } }),
      createInteractionWorker({ tools: [readTextTool] }),
    ],
  });
  try {
    const skill = await runSkillFlow(runtime, {
      context: { items: [{ id: "task", content: "Read the project README." }] },
      sources: [{ id: "review-skill", content: "Review correctness and tests." }],
    });
    const selected = await runRagFlow(runtime, { context: skill.context, query: "tests", limit: 1 });
    assert.deepEqual(selected.context.items.map(item => item.id), ["review-skill"]);
    const tool = await runToolCallFlow(runtime, {
      context: selected.context,
      call: { id: "read-1", name: "read_text", arguments: { path: "README.md" } },
    });
    assert.equal(tool.output.status, "success");
    assert.equal(tool.observation.message.role, "tool");
    assert.equal(tool.context.items.length, 2);
    return { selectedIds: selected.context.items.map(item => item.id), toolStatus: tool.output.status };
  } finally { await runtime.close(); }
}
```

示例使用当前条目的真实子串检索；向量/BM25/混合检索换成数据库或 RETRIEVAL Provider，流程接口不变。RAG 只返回选中的 Context，不生成答案。SELECT 返回 context/selectedItemIds/purpose；传入 INFER 前由应用映射为 messages，见 [Context → Infer](context.zh-CN.md)。

MCP 的两个分支：

```ts
export async function mcpFlows(runtime: RuntimeClient, context: Context, server: string, call: ToolCall) {
  // The caller registers CONTEXT and an INTERACTION Worker with a connected MCP client.
  const discovered = await runMcpFlow(runtime, { context, request: { operation: "discover", server } });
  if (!discovered.output.capabilities.some(capability => capability.name === call.name && capability.server === server)) {
    throw new Error(`MCP capability not found: ${server}/${call.name}`);
  }
  const invoked = await runMcpFlow(runtime, {
    context: discovered.context, request: { operation: "invoke", server, call },
  });
  return { capabilities: discovered.output.capabilities, ...invoked };
}
```

发现到的 capabilities 是 schema 描述，不是 ExternalResult，不能直接传入 OBSERVE。MCP SDK 接入见 [Interaction API](interaction.zh-CN.md)。以上流程没有第三个 options 参数；从 Worker handler 传 ctx 时继承本地执行信号。需要按节点绑定 Worker、Graph 并发或显式 signal 时，将相同叶子组合成 graph，再使用 runtime.run(plan,input,options)。

## ReAct

`runReactFlow(runtime, input, options?)` 接受提供 run/services 的 Runtime。input 为 SAMPLE 输入（model/messages/generation/actions/metadata）加 constraints；options 为 `{graphId?,signal?,timeoutMs?}`。需要 INFER 以及动作目标所对应的 Worker，不要求 CONTEXT Worker。模型只产生 ActionRequest；运行流程负责执行并把 Observation 反馈到下一次 SAMPLE。

```ts
export async function reactFlow(runtime: DittoRuntime, model: ModelConfig) {
  // Register INFER and INTERACTION with readTextTool; configure the model provider and Sandbox.
  const result = await runReactFlow(runtime, {
    model, messages: [{ role: "user", content: "Read README.md and summarize this project." }],
    actions: [{ name: readTextTool.name, description: readTextTool.description!, inputSchema: readTextTool.inputSchema }],
    constraints: { maxSteps: 4, maxActionCalls: 2, maxTotalTokens: 16_000 },
  }, { graphId: "readme-agent", timeoutMs: 30_000 });
  if (result.status !== "completed") throw new Error(`ReAct stopped: ${result.stopReason}`);
  return result;
}
```

返回 ReactFlowResult：result、samples、observations、actionRequests、usage，以及 status（completed/partial/failed）、stopReason 和可选 error，不套 NodeResult。示例把非 completed 转为异常，应用也可展示 partial 并保留未解决动作。

约束优先级、动作 target（Tool/MCP/公开 Node）与停止原因见 [ReAct 详细说明](../interaction-runtime.zh-CN.md#react-预定义-graph-流程)。本地信号传递到模型与动作 handler；HTTP/IPC 取消只结束调用端等待。Token 预算依据 Provider usage 限制后续采样，不是硬计费上限；流程不会自动重试外部动作。
