# 统一配置 API

[English](configuration.md) · [Worker API](README.zh-CN.md)

根目录 [`ditto.yaml`](../../ditto.yaml) 是可提交的行为参数配置；[`.env.example`](../../.env.example) 是部署模板，真实 `.env` 被 Git 忽略。Node 用 `--env-file=.env` 加载环境变量，应用显式加载 YAML，一次构建的 Runtime services 供所有 Worker 使用。导入库、创建默认 Runtime 不会读取文件或环境变量。

```ts
import { createDitto, createInfer, createInferWorker, loadRuntimeConfigFile } from "@ditto/core";
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const runtime = createDitto({ config, workers: [createInferWorker()] });
const infer = createInfer({ runtime });
const result = await infer.reasoning.trajectory({
  model: { provider: config.model!.provider, model: config.model!.model },
  messages: [{ role: "user", content: "计算 17 × 23，只返回整数。" }],
  strategy: { name: "tot" }, // 使用 YAML 中的 breadth / depth / beamWidth
});
await runtime.close();
```

## 分组结构

```yaml
runtime:               # 超时与 Graph 编排
  timeoutMs: 120000
  maxTurns: 8
  react: {}            # ReAct 参数
shared:
  providers: {}        # 共享供应商请求行为
workers:
  memory:
    queryLimit: 100
    searchLimit: 10
  infer:               # INFER 专属参数
    generation: {}
    constraints: {}
    strategies: {}
    deliberate: { mode: select, selectCount: 1, generation: { maxTokens: 4096 } }
```

`.env` 使用相同的归属前缀，并用注释分区：

| 归属 | env 前缀 |
| --- | --- |
| Runtime | `DITTO_RUNTIME_*` |
| 共享供应商 | `DITTO_SHARED_PROVIDERS`、`DITTO_SHARED_PROVIDER_<NAME>_*` |
| 共享权限 | `DITTO_SHARED_SANDBOX_ALLOW_*` |
| INFER Worker | `DITTO_WORKER_INFER_*` |
| HTTP 通信 | `DITTO_TRANSPORT_HTTP_*` |

INFER、MEMORY 与可选 RETRIEVAL 消费各自的专属配置；数据库连接配置由外部插件负责。`.env` 中的 HTTP token 由通信启动代码读取，不进入推理请求，也不放入 YAML。旧的 YAML 顶层 infer/providers/react 和旧 env 前缀会报错，需要按上述结构迁移。

## 配置边界

| 文件 | 配置内容 |
| --- | --- |
| `.env` | `DITTO_RUNTIME_ENV`、`DITTO_RUNTIME_WORKSPACE`；启用供应商的 `DITTO_SHARED_PROVIDERS`；默认模型 `DITTO_WORKER_INFER_MODEL_PROVIDER` + `DITTO_WORKER_INFER_MODEL`；每家供应商 `DITTO_SHARED_PROVIDER_<NAME>_KIND/BASE_URL/API_KEY/MODEL`；`DITTO_SHARED_SANDBOX_ALLOW_NETWORK/TOOLS/MCP/SKILLS/READ/WRITE/EXECUTE` 部署权限；应用显式读取的 HTTP Worker token |
| `ditto.yaml` | Runtime 超时与循环次数、INFER 采样参数与轨迹预算、各推理策略的轮数/宽度/深度、ReAct 动作预算、供应商请求行为、MEMORY 查询/搜索条数 |
| 单次 Node 输入 | 本次消息、模型、候选、反思标准等业务内容，以及可选的参数覆盖 |

旧的 `DITTO_TIMEOUT_MS`、`DITTO_MAX_TURNS`、`DITTO_SHARED_PROVIDER_*_OPTIONS/MAX_TOKENS_FIELD` 已迁移到 YAML；仍在 env 中设置会抛出迁移提示，避免两份配置互相覆盖。YAML 不做 `${ENV}` 插值，不允许 `apiKey` / `baseUrl` 等部署字段。供应商 options 是透传参数对象，不要放任何凭证。

## 加载接口

```ts
loadRuntimeConfigFile(path = "ditto.yaml", env = process.env): RuntimeConfig
loadRuntimeConfig(env = process.env, settings: RuntimeSettings = {}): RuntimeConfig
```

第一个接口读取 UTF-8 YAML；相对路径基于当前工作目录。第二个是纯配置解析，供测试、嵌入式应用传对象使用，不访问文件。这次分组调整作用于输入文件和 RuntimeSettings；加载后仍返回原有的不可变配置快照，包含 `environment/workspace/model/providers/timeoutMs/maxTurns/infer/memory/retrieval/react/sandbox`。配置只读取一次；修改 YAML 后需重新加载并创建 Runtime。Worker 通过 `ctx.services.config` 访问同一快照。

缺失文件、空文件、非对象、未知字段、重复键、YAML alias、非法数字在启动时抛错，不静默退回默认值。只使用标准 YAML 数据结构，不使用自定义 tag 或 merge key。显式自定义 `providers` Registry 时，Runtime 不再从配置构建 HTTP Provider。

## YAML 字段

字段可省略；下表区分库内置回退值与仓库当前 YAML 配置。单次请求优先，其次配置，最后库回退值。

| 路径 | 含义与范围 | 库回退 / 当前 YAML |
| --- | --- | --- |
| `runtime.timeoutMs` | 单次 INFER / ReAct 超时，整数 1–2147483647 毫秒 | 30000 / 120000 |
| `runtime.maxTurns` | ReAct 默认轮数，正安全整数 | 8 / 8 |
| `workers.infer.generation.maxTokens` | 每次生成上限，正安全整数；供应商可能含内部推理 Token | 供应商默认 / 4096 |
| `workers.infer.generation.temperature/topP/topK/stop/seed` | 与 [GenerationConfig](infer.zh-CN.md) 相同：0–2 / 0–1 / 正整数 / 非空字符串数组 / 安全整数 | 均未指定 |
| `workers.infer.constraints.maxSteps` | 轨迹最多模型调用数，含评估/合并调用，正安全整数 | 16 / 16 |
| `workers.infer.constraints.maxTotalTokens` | 整条轨迹累计预算，正安全整数；需要真实 usage | 不设上限 / 64000 |
| `workers.infer.constraints.timeoutMs` | 轨迹额外时限，范围同 runtime.timeoutMs | 均未指定 |
| `workers.infer.strategies.cot.rounds` | 线性求解轮数，1–64 | 2 / 2 |
| `workers.infer.strategies.long-cot.rounds` | 长路径求解轮数，1–64 | 4 / 4 |
| `workers.infer.strategies.tot.breadth/depth/beamWidth` | 每父节点分支数 / 搜索深度 / 保留宽度，各 1–16 | 3/2/2 / 2/2/2 |
| `workers.infer.strategies.got.breadth/depth` | 每层贡献数 / 聚合层数，各 1–16 | 3/2 / 2/2 |
| `workers.infer.strategies.self-consistency.candidates` | 独立采样次数，1–16 | 3 / 3 |
| `workers.infer.deliberate.mode` | 默认审议模式：select / merge / consensus / debate | select / select |
| `workers.infer.deliberate.selectCount` | select 模式保留数量，正安全整数；不能超过请求候选数量 | 1 / 1 |
| `workers.infer.deliberate.generation` | DELIBERATE 专属 GenerationConfig，覆盖 INFER 通用采样默认值 | 继承 / maxTokens=4096 |
| `runtime.react.maxActionCalls` | ReAct 动作调用数，非负安全整数 | 16 / 16 |
| `runtime.react.maxTotalTokens` | ReAct 累计采样预算，正安全整数 | 不设上限 / 64000 |
| `shared.providers.<name>.maxTokensField` | 兼容协议使用 `max_tokens` 或 `max_completion_tokens` | 未指定时兼容适配器使用后者 |
| `shared.providers.<name>.options` | 供应商原生请求参数对象，如 thinking；不包含路由和凭证 | 空 |

YAML 中的供应商名称只设置行为，不自动启用供应商；由 `.env` 的 `DITTO_SHARED_PROVIDERS` 决定启用集合。未启用项可作为共享模板保留。`maxTokensField` 仅适用于启用的 OpenAI 兼容供应商。

## 覆盖与预算

- `generation`、`constraints` 和当前策略的 `strategy.options` 按字段覆盖，不修改原始输入；例如只传 `depth: 3` 仍保留 YAML 的 breadth 和 beamWidth。REFLECT / DELIBERATE 的内部 SAMPLE 同样继承 generation。
- SDK `createInfer({ runtime })` 与 Runtime Worker 使用相同默认值。`InferOptions.defaults?: InferSettings` 可用于独立 SDK，或为某 Worker **整体替换** Runtime 的 infer 默认配置；省略时继承 Runtime。自定义策略仍通过 `strategies` 函数注册，其 options 放单次请求中。
- 调用级 `timeoutMs` 优先于 Worker/SDK 构造选项，再到 Runtime 超时；轨迹 constraints.timeoutMs 与它取较小值。单次 constraints.timeoutMs 可以覆盖 YAML 的额外时限。
- 轨迹嵌套 SAMPLE 的 maxTokens 取剩余总预算与生成上限的较小值。增大深度可能先达到 maxSteps/maxTotalTokens，返回 partial 和明确 stopReason，不虚报 completed。当前 YAML 的 ToT 为 8 次模型调用，GoT 为 6 次。
- `runReactFlow` 是 Runtime 预定义 Graph，使用 runtime.maxTurns、react 预算和 workers.infer.generation；不读取 infer 的轨迹策略参数。

运行 `npm run check:infer:live -- --provider deepseek` 使用同一 YAML；`--max-tokens` 仅覆盖该次实验的生成上限。报告记录有效默认配置与真实结果，见 [实测报告](infer-live-report.md)。

DELIBERATE 的 mode/selectCount 优先使用请求字段，再使用 workers.infer.deliberate，最后回退为 select / 1。配置中的 selectCount 仅在实际模式为 select 时生效；请求显式为其他模式传入 selectCount 会报错。数量超过实际候选数时，在调用供应商之前返回 INVALID_INPUT，不会静默裁剪。采样优先级为：请求 generation > deliberate.generation > infer.generation > 供应商默认值。ToT 显式指定选择模式与保留数量，GoT 显式指定 merge；内部评估继承 DELIBERATE 采样配置，但始终受轨迹剩余 Token 预算限制，轨迹请求显式 generation 仍优先。

## MEMORY

`workers.memory.queryLimit` / `searchLimit` 必须为 1–10000 整数，内置和根 YAML 默认分别为 100 / 10，加载后位于 `config.memory`。逐字段优先级为请求 limit > MemoryOptions.defaults > Runtime YAML > 内置默认。独立 SDK 通过 `defaults: config.memory` 接入。数据库 env 由外部插件读取，Core 不解析数据库连接或凭据。见 [MEMORY API](memory.zh-CN.md)。

## RETRIEVAL （可选）

`workers.retrieval.searchLimit` 为 1–10000 整数，默认 10，加载为 `config.retrieval`。请求 limit > options.defaults.searchLimit > Runtime YAML > 内置默认。根 YAML 中出现该字段不会安装/注册/启动 Worker；应用必须显式导入可选入口并调用 createRetrievalWorker。连接、凭据和模型句柄由应用 Provider 管理，不增加数据库 env 占位项。详见 [RETRIEVAL API](retrieval.zh-CN.md)。
