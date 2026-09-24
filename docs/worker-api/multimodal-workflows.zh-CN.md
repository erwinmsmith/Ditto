# 文档与多模态理解的公开 API 组合

[English](multimodal-workflows.md) · [八项示例](../../examples/capabilities/multimodal/README.zh-CN.md)

PDF/Word 阅读、比较、规则审查、图片与图表理解、录音转写、视频理解和会议纪要使用相同的公开 Worker 接口。Core 负责调度、模型消息、上下文和记忆；格式解码、抽帧、媒体依赖与业务校验由应用提供。

| 阶段 | 公开调用 | 应用职责 |
| --- | --- | --- |
| 读取检查点 | `MEMORY.GET` | 固定任务请求指纹，拒绝复用 ID 修改输入 |
| 获取原始资料 | `INTERACTION.ACT.TOOL` → `INTERACTION.OBSERVE` | 核对哈希、保存快照、PDF/DOCX 解析、ASR、抽帧 |
| 保存资料 | `MEMORY.WRITE` | 将来源位置和媒体描述符保存到数据库 |
| 加载上下文 | `CONTEXT.LOAD` | Redis 未命中时从 Memory 重建，连接错误直接传播 |
| 理解资料 | `INFER.REASONING.SAMPLE` | 文本模型或显式选择的视觉模型，输出结构化分析 |
| 验证与交付 | `MEMORY.WRITE`、`INTERACTION.ACT.TOOL` | 校验原文引用/位置/算术，保存 JSON、Markdown、转写文本 |

## 消费端调用

安装 `@codesoul-co/ditto`，将所需 `examples/capabilities/multimodal` 与应用工具复制到消费项目；示例代码不包含在 Core npm tarball 中。消费项目安装 `redis`，配置媒体 Python 依赖。以下代码可保存为消费项目根目录的 `multimodal-app.ts`：

```ts
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { mediaTools } from "./examples/_shared/tools/multimodal/tools.ts";
import { resumeFixture } from "./examples/_shared/tools/multimodal/fixtures.ts";
import { sandbox, mediaConfig, models } from "./examples/capabilities/multimodal/cli.ts";
import { runMultimodal } from "./examples/capabilities/multimodal/shared.ts";

const directory = resolve(process.argv[2]!);
const request = await resumeFixture(directory);
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const storage = await openAgentStorage(directory, config);
try {
  const runtime = createDitto({
    config,
    sandbox: sandbox(config),
    workers: [
      ...storage.workers,
      createInferWorker(),
      createInteractionWorker({ tools: mediaTools(directory, request, mediaConfig()) }),
    ],
  });
  try {
    const result = await runMultimodal(runtime, { request, ...models(config) });
    console.log(JSON.stringify(result));
  } finally {
    await runtime.close();
  }
} finally {
  await storage.close();
}
```

```sh
node --env-file=.env multimodal-app.ts /absolute/task-directory
```

`runMultimodal(runtime, input, options)` 与各入口的 `run` 是应用组合函数，不是新增 Core 导出。`input` 包含 `request`、文本 `model: ModelConfig` 和可选 `visionModel: ModelConfig`。含图像的任务必须配置 `visionModel`，不会降级成纯文本模型。`options` 支持 `signal` 与 `stopAfter: "material" | "analysis"`。

`request` 包含 `id`、`tenant`、`mode`、`instruction` 以及 `sources: { id, path, mediaType, sha256 }[]`；文件应位于可信任务目录。需要新模型重新分析时也应使用新任务 ID，完成检查点不会因为模型配置变化而重跑。默认存储可以换为公开 `MemoryStore` 适配器；本示例的实测默认存储为 SQLite。

## 原生图片消息

现有 INFER 消息支持供应商原生内容数组。OpenAI-compatible 视觉 Provider 可接收：

```ts
const result = await runtime.invoke("INFER.REASONING.SAMPLE", {
  model: { provider: "glm", model: "glm-4.6v-flashx" },
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "Describe the image; cite source-1, image:1." },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } },
    ],
  }],
  generation: { maxTokens: 8192, temperature: 0 },
});
```

将占位 Base64 替换为校验过的实际图片。完整示例用 `multimodal_images` 工具加载字节，将 `sourceId`、图片位置或视频时间戳紧邻图片传入模型。Core 不读取本地媒体路径、不自动抽帧、不进行跨供应商协议转换。音频先由应用 ASR 工具转写，再通过文本消息理解；没有将音频伪装成图片或文本模型原生输入。

## 返回值与证据

分析返回 `summary`、`findings`、各模式的 `data` 和 `limitations`。每条 finding 包含 `statement/sourceId/location/quote`。文本 quote 必须是来源位置中的精确子串；视觉 quote 为空，证据是实际传入的像素及其校验值。报告保留 PDF 页、DOCX 段落、ASR 时间段、视频采样时刻及解析引擎。图表数值另外校验最大值与增量。

此机制验证引用可追溯性，并非语义正确性证明。视频仅覆盖采样帧、默认音频转写仅验收英语、DOCX 仅正文/表格段落，完整边界见[示例说明](../../examples/capabilities/multimodal/README.zh-CN.md)。外部发布与人工审批属于独立控制流程。

## 包边界验收

`npm run check:examples:multimodal:tasks:package` 从原始媒体执行完整任务，并覆盖 Redis 过期、数据库故障与 SIGKILL 恢复。消费端没有 Core 源码，没有 TypeScript paths 别名；私有入口被运行时钩子拦截。Python 解释器与媒体库是外部依赖，解析脚本复制进消费项目，不从仓库源码回退加载。
