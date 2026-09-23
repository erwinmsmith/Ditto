# RETRIEVAL Worker API（可选）

[English](retrieval.md) · [Worker API](README.zh-CN.md)

RETRIEVAL v0.1 只提供 `RETRIEVAL.SEARCH`。它是按需启用的通用相关性检索执行层，适用于搜索需要独立 CPU/GPU、连接资源、服务部署或水平扩容的场景。Core Worker 仍然只有 INFER、CONTEXT、MEMORY、INTERACTION。

当前随同一包的可选入口 `@ditto/core/worker/retrieval` 分发，没有新增独立 npm 包或第三方依赖。Core 根入口和 `@ditto/core/worker` 不导出/加载 RETRIEVAL；只有显式导入并注册后才执行。YAML 配置不会启动 Worker。默认 MEMORY/CONTEXT 的本地或外部 Provider 接入不变，普通部署无需增加一跳远程调用。

## 按需启用

```ts
import { createDitto, loadRuntimeConfigFile } from "@ditto/core";
import {
  createRetrievalWorker, RetrievalTargetRegistry,
  type RetrievalSearchProvider,
} from "@ditto/core/worker/retrieval";

function startRetrieval(kbProvider: RetrievalSearchProvider, codeProvider: RetrievalSearchProvider) {
  const providers = new RetrievalTargetRegistry({
    "company-kb": { defaultStrategy: "hybrid", providers: { hybrid: kbProvider } },
    "code-index": { defaultStrategy: "bm25", providers: { bm25: codeProvider } },
  });
  return createDitto({
    config: loadRuntimeConfigFile("ditto.yaml", process.env),
    workers: [createRetrievalWorker({ providers, concurrency: 8 })],
  });
}
```

Provider 是应用传入的已有实现。将 MEMORY/CONTEXT 中使用的底层检索函数包装成 RetrievalSearchProvider，沿用同一后端与算法；远端 Provider 不应反向调用已经转接到自己的 MEMORY.SEARCH。可以复用已有检索函数，或连接向量数据库、全文索引、图数据库、远程检索 API。可选模块已提供批量/HTTP embedding、向量检索接线、数据库原生全文检索适配、加权 RRF 融合与可替换重排。SQL/Milvus 通过应用已有客户端注入，Ditto 不安装数据库或驱动，也不管理索引。Graph/custom 策略继续由对应 SearchProvider 执行。完整 API 和接线方式见[检索链路与数据库适配](retrieval-providers.zh-CN.md)。不创建空的 EMBED/RANK 目录。

应用决定是否将该 Worker 注册到本地 Runtime，或在独立服务进程中启动。Core 没有自动根据负载启停服务的机制。

## 公共类型与 API

```ts
interface RetrievalQuery { content: unknown; metadata?: Record<string, unknown>; }
interface RetrievalTarget {
  name: string;
  type?: string;
  namespace?: string;
  metadata?: Record<string, unknown>;
}
interface RetrievalCandidate {
  id?: string;
  content: unknown;
  score?: number;
  source?: { target?: string; ref?: string };
  metadata?: Record<string, unknown>;
}
interface RetrievalSearchInput {
  query: RetrievalQuery;
  target: RetrievalTarget;
  strategy?: string;
  filter?: Record<string, unknown>;
  limit?: number;
  options?: Record<string, unknown>;
}
interface RetrievalSearchOutput {
  candidates: readonly RetrievalCandidate[];
  strategy?: string;
  target: RetrievalTarget;
  metadata?: Record<string, unknown>;
}
interface RetrievalSearchProvider {
  search(input: RetrievalSearchInput, context?: RetrievalExecutionContext): Promise<RetrievalSearchOutput>;
}
interface RetrievalProviderRegistry {
  resolve(target: RetrievalTarget, strategy?: string): RetrievalSearchProvider;
}
interface RetrievalResources { readonly providers: RetrievalProviderRegistry; }
interface RetrievalOptions extends RetrievalResources {
  readonly defaults?: RetrievalDefaults;
  readonly concurrency?: number;
}
```

- `createRetrievalWorker(options): WorkerDefinition`：注册唯一叶子 SEARCH，复用现有 Runtime 路由、并发和关闭语义。
- `createRetrieval(options).search(input, runtimeDefaults?, context?)`：直接 SDK；defaults 包含 searchLimit 及嵌套 embedding/hybrid/rerank 配置，context 可传进程内 AbortSignal。直接 SDK 不限制并发。见[Provider 配置](retrieval-providers.zh-CN.md)。
- `runtime.invoke("RETRIEVAL.SEARCH", input)` / `ctx.invoke(...)`：使用共享 `NodeResult<RetrievalSearchOutput>`，含 executionId、node、status、output/error。
- `retrievalSearchNode`：语义身份 scaffold。SEARCH 的 TypeScript 契约通过可选入口增强 NodeContractMap，不加入 Core 的默认契约导出。

query.content 必须存在，可为字符串、向量或任意自定义对象；具体格式由 Provider 校验。target.name 必须由调用者指定，不自动选 corpus。其他名称字段非空；metadata/filter/options 为对象；limit 是 1–10000 整数。

HTTP 跨进程调用使用 JSON，内容应遵循应用约定的可序列化格式；本地 SDK 不强制把 content 转成字符串。Target 是逻辑标识，不是数据库连接描述，API 不接收专用 credential、collection 或连接 URL 字段。私有后端配置保留在 Provider 中。

```ts
const result = await runtime.invoke("RETRIEVAL.SEARCH", {
  query: { content: "agent memory migration" },
  target: { name: "company-kb" },
  strategy: "hybrid",
  filter: { year: { gte: 2024 } },
  limit: 20,
});
if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
const candidates = result.output.candidates;
```

### Target 与 Strategy 绑定

```ts
const providers = new RetrievalTargetRegistry({
  "agent-memory": {
    defaultStrategy: "vector",
    providers: { vector: vectorProvider, hybrid: hybridProvider },
  },
});
```

`RetrievalTargetRegistry` 是内置的最小 Registry 实现；每个 target 绑定一个默认策略及策略到 Provider 的映射。可以将同一个 Provider 注册到多个策略。绑定在创建时形成快照，查找使用 Map；不做网络发现或动态建库。不提供热注册/自动回退。

调用未提供 strategy 时使用该 target 的 defaultStrategy，选中的策略会传入 Provider 并写入输出。未知 target 和未注册 strategy 明确失败；默认策略必须已注册。`rag` 不允许作为策略。Vector、BM25、hybrid、graph 等只作为 Provider/策略名，Worker 不固化 EMBED → RETRIEVE → RANK 流水线。

内置 Registry 按 target.name 查找，target.type/namespace/metadata 原样传递给 Provider。namespace 不是访问凭证；租户权限和命名空间合法性应由 Provider 或自定义 `RetrievalProviderRegistry.resolve` 校验。自定义 Registry 也负责解释缺省策略。

### 输出与归一化

Provider 返回原始 RetrievalSearchOutput，不返回第二层 NodeResult。Worker 校验候选数组、必需 content、可选 id/source/metadata、有限 score 和结果数。输出 target 的 name/type/namespace 必须与请求一致；显式策略也必须一致。错误结果不会被静默截断或当成成功。

输出 target 使用请求的逻辑标识，缺省策略由内置 Registry 补齐。候选及输出 metadata、source ref、排序和 score 原样保留；不重新评分、排序、去重或补造 id。不同来源可以有同名 id，候选也可无 id。空结果为 `{ candidates: [], target, strategy? }`。

## MEMORY 可选转接

普通部署继续传入自己的 MemorySearchProvider。需要独立检索服务时，才导入第二个可选入口：

```ts
import { createMemoryWorker } from "@ditto/core";
import { RemoteRetrievalSearchProvider } from "@ditto/core/worker/retrieval/adapters/memory";

const search = new RemoteRetrievalSearchProvider({
  runtime, // 本地或已配置 HTTP 远程 Worker 的 Runtime
  target: { name: "agent-memory" },
  mapOutput(output) {
    return output.candidates.map(candidate => {
      // 此应用约定 candidate.id 是 Memory ID，content 是完整的记忆内容。
      if (!candidate.id) throw new Error("Missing Memory ID");
      return {
        memory: { id: candidate.id, content: candidate.content,
          ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }) },
        ...(candidate.score === undefined ? {} : { score: candidate.score }),
        metadata: { source: candidate.source },
      };
    });
  },
});
runtime.register(createMemoryWorker({ store: applicationMemoryStore, search }));
```

`RemoteRetrievalSearchOptions` 包含必填 target、可选 `runtime?: Pick<RuntimeClient, "invoke">` 和 mapOutput。candidate.content 为完整 MemoryItem 时可省略 mapOutput，使用默认映射保留 key/content/metadata；其它候选结构需显式提供 mapOutput，可同步或异步返回完整 MemorySearchOutput；它一次接收所有候选，便于在需要时批量补全记录。转接器不会自行创建存储连接、推断 Memory ID 或执行 N 次 SQL GET。

转接关系：MemorySearchInput.query → query.content；strategy/filter/limit/options 原样传递；target 固定在应用配置中。SEARCH 失败时不调用 mapper。转接器通过 Runtime 调用公共节点，只依赖 MEMORY 的类型接口，不导入其执行实现。MEMORY 调用方仍使用原来的输入、输出和 NodeResult。

转接失败在 MEMORY Worker 中遵循其现有异常规则，返回 `MEMORY_BACKEND_ERROR`；直接 RETRIEVAL 调用可获得下面的详细错误码。内置转接器不把远端错误原文转发给 MEMORY 调用者。

## 独立部署与扩容

服务进程创建只包含 RETRIEVAL Worker 的 Runtime，然后使用现有 HTTP handler：

```ts
import { createServer } from "node:http";
import { createWorkerHttpHandler } from "@ditto/core";

const token = process.env.DITTO_TRANSPORT_HTTP_WORKER_TOKEN;
if (!token) throw new Error("Missing transport token");
const server = createServer(createWorkerHttpHandler(retrievalRuntime, { token }));
server.listen(8080, "127.0.0.1");
// 将 retrievalRuntime.workers()[0].address 通过部署配置交给调用方。
```

调用方安装已有 transport 并注册该地址，不在 Node 请求中放网络位置：

```ts
import { createHttpTransport } from "@ditto/core";
const transport = createHttpTransport({ id: "retrieval-service", url, token });
const runtime = createDitto({ transports: [transport] });
runtime.registerRemote({ address, transportId: transport.id, capabilities: ["RETRIEVAL.SEARCH"] });
```

每个服务地址安装一个 transport，可注册多个副本。详见 [Worker 通信](../worker-communication.zh-CN.md)。`concurrency` 是每副本的并发入口上限；Runtime 优先选择本地、同主机、远端，并在同优先级可用副本间轮转。全部本地副本满载时立即拒绝，不新建等待队列、不自动重试、不自动扩容机器；远端容量由接收方执行。

路由按 Node capability，不按 target。加入同一调用方候选池的副本必须支持该池所需的相同逻辑 target/strategy 集合。不同 target 可在每个 Registry 中连接不同后端集群；若必须使用彼此不兼容的专用服务池，应用需使用独立 Runtime/transport 绑定，而不能期待调度器推断目标亲和性。

同进程副本共享事件循环，不会增加 CPU 核心。CPU/GPU 隔离和多核计算需部署到独立进程/机器。Worker 的价值是执行资源隔离和扩容边界，不能保证启用后单次检索更快。

注入的 Provider/Registry 由应用持有；同一 Worker definition 注册多次会共享这些对象。需要独立连接/模型句柄时分别创建 definition。关闭 Runtime 会停止路由并等待已接受请求结束，应用随后关闭 Provider 连接及 HTTP server。Worker 不保存业务事实或拥有 corpus。

## 配置与错误

```yaml
workers:
  retrieval:
    searchLimit: 10
    embedding:
      batchSize: 64
    hybrid:
      candidateLimit: 100
      rrfK: 60
    rerank:
      candidateLimit: 100
```

根目录 YAML 经 loadRuntimeConfigFile 读取为 `config.retrieval`。优先级：请求 limit > options.defaults.searchLimit > Runtime YAML > 内置 10。直接 SDK 可传 `defaults: config.retrieval`。配置在启动时读取，热路径没有文件 I/O。数据库/检索服务地址与凭据由应用 Provider 读取 env；通信沿用现有 HTTP token；可选 HTTP embedding 由工厂显式读取 RETRIEVAL 分组的 env 地址、模型和凭据。详见[配置与接线](retrieval-providers.zh-CN.md)。

| 错误码 | 语义 |
| --- | --- |
| RETRIEVAL_INVALID_INPUT | 公共参数不合法 |
| RETRIEVAL_TARGET_NOT_FOUND | target 未注册 |
| RETRIEVAL_STRATEGY_UNSUPPORTED | 该 target 不支持策略，或使用 rag 策略 |
| RETRIEVAL_PROVIDER_UNAVAILABLE | Registry/Provider 未提供可调用的方法 |
| RETRIEVAL_INVALID_BACKEND_OUTPUT | 输出形状、目标、策略或条数不符合契约 |
| RETRIEVAL_BACKEND_ERROR | 未分类后端异常，隐藏原始信息 |
| RETRIEVAL_INVALID_EMBEDDING | 向量数量、索引、数值或维度错误 |
| RETRIEVAL_CANCELLED | 本地 SDK 信号取消，status 为 cancelled |
| RETRIEVAL_TIMEOUT | Provider 显式报告超时，NodeResult.status 为 timeout |
| RETRIEVAL_PERMISSION_DENIED | Provider/自定义 Registry 显式拒绝权限 |

Provider 可抛出 `new RetrievalError(code, safeMessage)`；message 是公开内容，不能包含凭据或私有连接信息。其他异常转换为通用错误。

直接 SDK 的取消信号经 context 协作式传给 Provider，HTTP embedding 自带请求 deadline；其他后端 deadline/cancellation 由 Provider 自己实现；没有 Promise.race 超时后仍占用资源却提前释放并发配额的逻辑。HTTP transport 的客户端 timeout 只停止客户端等待，不保证服务端计算被取消。Runtime 注册/路由/通信层的失败仍按已有规则拒绝 Promise；不伪装成成功的空候选。

## 用户 Graph

RAG 由用户 Graph 组合 `RETRIEVAL.SEARCH → 显式候选映射 → CONTEXT.UPDATE → INFER`。SEARCH 不更新 Context、不写 Memory、不调用 INFER/Tool，也不改写 query。候选到 ContextItem 的映射由调用方决定，不将 content 强制解释成文档或 Message。

## 逐 API 使用示例

完整代码：[examples/retrieval.ts](examples/retrieval.ts)。下列函数共用该文件的 imports；函数不会在导入时自动执行。数据库、模型和 MCP 参数由应用注入，不是 Ditto 内置的模拟后端。选择需要的函数调用；写入、删除、模型调用等会产生对应的真实操作。

```ts
import { createDitto, createMemoryWorker, loadRuntimeConfigFile } from "@ditto/core";
import type { MemorySearchProvider, MemoryStore, MemoryItem } from "@ditto/core/worker/memory";
import {
  createRetrieval, createRetrievalWorker, RetrievalTargetRegistry, RetrievalError, retrievalSearchNode,
  embedContents, validateVector, createVectorSearchProvider, createTextSearchProvider,
  createHybridSearchProvider, createCosineReranker, rerankCandidates, createRerankSearchProvider,
  createHttpEmbeddingProvider, embeddingConfigFromEnv, createSqlSearchProvider, createMilvusSearchProvider,
  type RetrievalSearchProvider, type RetrievalSearchInput, type RetrievalSearchOutput,
  type EmbeddingProvider, type RerankProvider, type SqlSearchOptions, type MilvusSearchOptions,
} from "@ditto/core/worker/retrieval";
import {
  createMemoryRetrievalProvider, createRetrievalMemorySearchProvider,
  RemoteRetrievalSearchProvider, mapMemoryCandidates,
} from "@ditto/core/worker/retrieval/adapters/memory";

export const request: RetrievalSearchInput = { query: { content: "agent memory" }, target: { name: "kb" }, limit: 5 };
```

本节共享 request 使用 `query.content="agent memory"`、`target.name="kb"`、`limit=5`。provider 参数必须支持该 target 的查询语义。

### createRetrieval / createRetrievalWorker：显式启用

providers 必填。createRetrieval 返回仅有 search 方法的直接 SDK；createRetrievalWorker 注册唯一 SEARCH 节点。concurrency 只约束 Worker，不影响直接 SDK。

```ts
export function setupRetrieval(provider: RetrievalSearchProvider) {
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  const providers = new RetrievalTargetRegistry({ kb: { defaultStrategy: "vector", providers: { vector: provider } } });
  const runtime = createDitto({ config, workers: [createRetrievalWorker({ providers, concurrency: 4 })] });
  const retrieval = createRetrieval({ providers, defaults: config.retrieval });
  return { runtime, retrieval };
}
```

### retrieval.search / RETRIEVAL.SEARCH：返回候选

示例比较本地 SDK 和 Runtime 调用。成功且无匹配时 output.candidates 为 []，仍然保留 target/strategy。Worker/SDK 不强制 candidate.id 存在。

```ts
export async function retrievalSearch(provider: RetrievalSearchProvider) {
  const { runtime, retrieval } = setupRetrieval(provider);
  try {
    const local = await retrieval.search(request);
    const routed = await runtime.invoke("RETRIEVAL.SEARCH", request);
    if (routed.status !== "success" || !routed.output) throw new Error(routed.error?.code ?? routed.status);
    return { local, candidates: routed.output.candidates, target: routed.output.target };
  } finally { await runtime.close(); }
}
```

### RetrievalTargetRegistry.resolve：选择 Provider

签名 `resolve(target, strategy?)`，省略策略时使用该 target 的 defaultStrategy。返回的包装 Provider 会将所选 strategy 传入后端并补到输出；直接调用它返回原始 Output，异常抛出。

```ts
export async function registryResolve(provider: RetrievalSearchProvider) {
  const providers = new RetrievalTargetRegistry({ kb: { defaultStrategy: "keyword", providers: { keyword: provider } } });
  const selected = providers.resolve({ name: "kb" });
  return selected.search({ ...request, limit: 5 }); // Raw output, strategy is filled with "keyword".
}
```

### search 的 runtimeDefaults / context 参数

完整签名 `search(input, runtimeDefaults = {}, context = {})`；第三参数传 signal，第二参数是默认值后备层，不是调用选项。SDK 会用工厂与 runtimeDefaults 合并结果覆盖 context.defaults，故默认配置不要放第三参数。没有自动 timeoutMs 参数。

```ts
export async function cancelRetrieval(provider: RetrievalSearchProvider) {
  const providers = new RetrievalTargetRegistry({ kb: { defaultStrategy: "custom", providers: { custom: provider } } });
  const retrieval = createRetrieval({ providers, defaults: { searchLimit: 5 } });
  const controller = new AbortController(); controller.abort();
  return retrieval.search(request, { searchLimit: 10 }, { signal: controller.signal });
}
```

### 节点描述符 type / define

`retrievalSearchNode.type` 为 RETRIEVAL.SEARCH；`.define(workerType, handler)` 固定节点身份与类型，不自动注册 Worker。下面让自定义 handler 复用 SDK 的校验和 NodeResult 包装。通常使用 createRetrievalWorker 更直接。

```ts
export function retrievalDescriptor(provider: RetrievalSearchProvider) {
  const providers = new RetrievalTargetRegistry({ kb: { defaultStrategy: "custom", providers: { custom: provider } } });
  const retrieval = createRetrieval({ providers });
  return retrievalSearchNode.define("RETRIEVAL", input => retrieval.search(input));
}
```

## 与 CONTEXT 组合

CONTEXT.SELECT 的 ragStrategy 可复用当前 SearchProvider，也可通过 Runtime 委托 RETRIEVAL.SEARCH。独立调用须先检查 NodeResult，再显式映射候选，返回 ContextItem[]；SELECT 不自动写回工作集。 [完整 CONTEXT API 与调用示例](context.zh-CN.md)。

```ts
export function remoteContextRetrieval(runtime: import("@ditto/core").RuntimeClient, target: RetrievalTarget) {
  return contextRetrieval({ async search(input) {
    const result = await runtime.invoke("RETRIEVAL.SEARCH", input);
    if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
    return result.output;
  } }, target);
}
```

[完整 imports 和代码](examples/context.ts)。

## Worker 调用上下文

内置 RETRIEVAL Worker 将 Runtime 当前 signal 传给 Provider 的 `RetrievalExecutionContext`，向量 embedding、数据库查询、融合与重排适配器继续传递它。直接调用示例：`await runtime.invoke("RETRIEVAL.SEARCH", { query: { content: "question" }, target: { name: "docs" } }, { signal: AbortSignal.timeout(5000) })`。MEMORY 和 CONTEXT 的委托适配器也会继承父调用上下文；CONTEXT 接入见 [Provider API](retrieval-providers.zh-CN.md#context-检索适配器)。HTTP/IPC 取消不等于服务端数据库执行已被取消。

在 MEMORY Worker 内构造 `RemoteRetrievalSearchProvider` 时，可省略 runtime，继承本次执行绑定的 Runtime；显式 runtime 始终优先，独立 SDK 委托则必须提供它。例如 Worker 内可用 `new RemoteRetrievalSearchProvider({ target: { name: "memories" } })`。
