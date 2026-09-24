# 内容处理 API

[English](content-workflows.md) · [Worker API](README.zh-CN.md) · [七项示例](../../examples/capabilities/content/README.zh-CN.md)

生成、改写、总结、扩展、翻译、格式转换和引用生成通过现有公开 API 组合：`INTERACTION.ACT.TOOL` 读取资料和写入文件，`INTERACTION.OBSERVE` 标准化工具结果，`CONTEXT.LOAD/UPDATE` 维护 Redis 工作上下文，`INFER.REASONING.SAMPLE` 生成及复核内容，`MEMORY.GET/WRITE` 保存数据库检查点。业务规则和渲染器属于应用，不新增 Core 内容类别节点。

## 完整调用

使用 Node.js 24+，按照 [示例安装说明](../../examples/capabilities/content/README.zh-CN.md) 配置真实模型和 Redis。将下面代码保存为仓库根目录 `content-example.ts`：

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { contentTools } from "./examples/_shared/tools/content/tools.ts";
import { createFixture } from "./examples/_shared/tools/content/fixtures.ts";
import { sandbox } from "./examples/capabilities/content/cli.ts";
import { run } from "./examples/capabilities/content/generate.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure a provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure a model");
await mkdir(".examples-content-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-content-tasks/example-"));
const request = await createFixture(directory, "generate");
const storage = await openAgentStorage(directory, config);
try {
  const runtime = createDitto({
    config,
    sandbox: sandbox(config),
    workers: [
      ...storage.workers,
      createInferWorker(),
      createInteractionWorker({ tools: contentTools(directory, request) }),
    ],
  });
  try {
    const result = await run(runtime, { request, model: { provider, model } });
    console.log(JSON.stringify({ directory, result }, null, 2));
  } finally { await runtime.close(); }
} finally { await storage.close(); }
```

```sh
npm run build
node --env-file=.env content-example.ts
```

代码创建演示资料，实际读取文件，调用模型生成并复核，最后发布 Markdown、JSON、HTML 和引用快照。将入口和 `createFixture` 模式同时改为 `rewrite`、`summarize`、`expand`、`translate`、`convert` 或 `cite` 可运行对应任务。

`run(runtime, { request, model }, options?)` 只依赖 Runtime 的公开 `run` 方法。`options.signal` 传播取消；`stopAfter` 支持 `material`、`draft`、`review`，返回 `{ status: "checkpoint" }`。正常完成返回 `{ taskId, mode, draft, review, delivery }`，其中 `delivery.files` 给出实际产物的文件名、SHA-256 和字节数。

## 输入和源资料

`Request` 包含任务 ID、租户、模式、三个需逐字保留的 `anchors` 以及 `sources: { id, file, sha256 }[]`。本示例接受 brief、notes、draft 三个固定文本源。生产应用可替换资料工具及领域校验；不应把自己的文件格式或业务术语加入 Core。

资料工具逐文件核对常规文件、长度和哈希，保留完整原文。证据块为 `{ id, line, text }`，如 `brief:3` 对应源文件第三行。Memory 保存快照和块映射，保证恢复、渲染和引用使用同一版本。源资料在提交前变更会失败；提交后恢复继续使用已保存快照，更新资料须新建任务。

## 生成与复核

生成 Graph 先从 Redis 加载当前材料，再向 `INFER.REASONING.SAMPLE` 提供 `model`、系统规则、当前任务要求和资料。`generation: { temperature: 0, maxTokens: 8192 }` 为调用级配置，正文另外按模式限制长度。检查 `NodeResult.status`、`output` 和 `finishReason === "stop"` 后才解析模型 JSON，截断响应不会发布。

生成结果的应用契约：

```ts
interface Draft {
  title: string;
  language: "zh-CN" | "en";
  sections: {
    heading: string;
    text: string;
    citations: { blockId: string; quote: string }[];
  }[];
}
```

每个标题、分节标题和正文必须非空；引文必须逐字等于已保存的原文块，不能凭空构造来源或行号。应用验证语言、长度、固定字段、数字、引用覆盖；转换模式还验证标题和每段正文逐字一致、顺序不变；扩展模式保留首段并补充有依据的内容。

通过第一轮验证后将草稿存入 Memory，并用 `CONTEXT.UPDATE` 供下一步复核读取。第二次真实模型调用返回：

```ts
interface Review {
  approved: boolean;
  checks: {
    fidelity: boolean;
    coverage: boolean;
    transformation: boolean;
    citations: boolean;
  };
  issues: string[];
}
```

只有全部检查为 true、approved 为 true 且 issues 为空，才能保存批准复核并发布。应用验证可以证明引用文本和字段一致，模型复核则检查语义；自动复核不是对自然语言正确性的数学证明，也不核实原始资料在现实中的真实性。专业或高风险内容仍可接入已有人工审核流程。

## 引用和文件格式

`content_publish` 注册工具再次校验草稿、资料和复核，从同一结构化内容生成文件。`content.json` 包含引用表，记录源文件、行号、引文及哈希。HTML 引用跳转到页面中的来源说明，并链接随包保存的原文；Markdown 保留来源路径和行号。模型不提供任意 URL 或文件路径。

HTML 和 Markdown 由应用安全转义；HTML 不运行模型代码。产物 `manifest.json` 最后写出，列出其余文件的哈希和大小。逐文件不可变写入允许相同内容重放，冲突内容失败；这不是跨全部文件的原子目录事务，发布中断可能留下部分已完成文件，恢复会核对并补齐。

## 存储和恢复

Context scope 为 `content:<tenant>:<id>`。通过公开 Memory 节点保存 `input`、`material`、`draft`、`review`、`report`，每条记录包含规范化请求指纹。只有 Context 不存在时按缓存缺失处理，连接错误会中止任务；Memory 不可用也不会回退到文件或进程内存。

资料在生成前提交，草稿在复核前提交，批准复核在发布前提交。恢复重建 Redis 并复用已提交的模型结果；文件发布后、报告落盘前崩溃可通过幂等写入恢复。应用负责关闭 Runtime、Memory 和 Redis 客户端。

## npm 包消费验收

`npm run check:examples:content:tasks:package` 在仓库外安装真实 npm tarball，单独安装应用 Redis SDK，使用无 paths 别名的严格 TypeScript，拦截私有 Core 入口和仓库路径回退，并验证七个入口的导入不触发任务。之后执行全部 32 个端到端场景，核对模型调用、真实存储、文件、引用和恢复。

验收使用真实模型生成和复核、Redis、文件 SQLite Memory，以及实际 UTF-8 文件和 HTML/Markdown/JSON 产物。没有把模型返回一段文本视为完整任务完成，也没有将本模块格式支持扩展描述为 Word/PDF 支持。

扩展模式由应用从已提交快照逐字保留原文首段，模型只生成新增分节；组合后统一校验和复核。
