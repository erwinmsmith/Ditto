# Graph 与 Loop：从依赖到动态执行

Graph 是不可变的有向无环图，定义一个阶段中的数据依赖。Loop 管理 Graph 的执行顺序、分支和重复。一个 Agent 可以包含多个阶段 Graph，但对外只启动一次 `runtime.loop`。

## 1. 节点定义的四个参数

```ts
const plan = graph<string>("question-context")
  .node("loaded", "CONTEXT.LOAD", [], question => ({
    sources: [{ role: "user", content: question }],
  }))
  .node("selected", "CONTEXT.SELECT", ["loaded"], (_question, { loaded }) => ({
    context: loaded, purpose: "infer", limit: 8,
  }));
```

| 参数 | 含义 | 常见错误 |
| --- | --- | --- |
| `loaded` | 图内唯一的结果 ID | 与全局 Node 类型混淆，或重复 ID |
| `CONTEXT.LOAD` | 可路由的语义叶子 | 写成不可调用的 `CONTEXT` 或 `INFER.REASONING` |
| `[]` / `["loaded"]` | 必须先完成的结果 | 在 binder 读取未声明的输出 |
| `(input, outputs) => payload` | 由图输入和依赖构建节点输入 | 在绑定函数内执行数据库/网络业务动作 |

`.node()` 返回新 Graph；已有 Graph 不变。Graph 不包含数据库实例、API key 或服务器地址。模型选择可以是受控的输入数据，但供应商密钥留在 Worker 的资源配置中。

## 2. 顺序、并行和汇合

```text
request → load → select → infer → output       顺序
request → search-a ─┐
        → search-b ─┴→ combine → infer         并行与汇合
```

没有依赖关系的节点可以同时就绪；汇合节点显式依赖两侧结果。`runtime.run(plan,input,{concurrency:2})` 限制图内同时执行的节点数。Worker 自己的 `concurrency` 是另一层限制：按副本限制入口调用，不是无限等待队列。

图不会将 `{status:"failed"}` 自动当作抛出的异常。下游 binder 必须根据实际返回契约检查状态。如果一个节点抛错，调度器停止启动后续节点；已经执行的外部动作不会因此撤销。需要保留部分成功结果时，让动作返回可检查的结果对象，再统一汇总。

## 3. 使用 Loop 组合不同阶段

下面是只依赖主包的完整 JavaScript，可保存为 `loop.mjs` 运行：

```js
import { createDitto, createContextWorker, graph, graphStep, loop } from "@codesoul-co/ditto";
const load = graph("load")
  .node("context", "CONTEXT.LOAD", [], text => ({ sources: [{ role: "user", content: text }] }));
const select = graph("select")
  .node("selection", "CONTEXT.SELECT", [], context => ({ context, purpose: "infer", limit: 1 }));
const plan = loop({
  id: "prepare-question", maxIterations: 2,
  *plan(question) {
    const loaded = yield* graphStep(load, question);
    const selected = yield* graphStep(select, loaded.context);
    return selected.selection;
  },
});
const runtime = createDitto({ workers: [createContextWorker()] });
try { console.log(JSON.stringify(await runtime.loop(plan, "Hello Ditto"), null, 2)); }
finally { await runtime.close(); }
```

这里 `maxIterations:2` 表示最多执行两次 Graph，不是每个阶段各有两次额度。失败的 Graph 也占次数。计划只 yield Graph invocation；生成器本身不打开文件、不调用 SDK、不执行 `runtime.run`。

## 4. 条件、重试和动态规划

在生成器中读取阶段结果后做普通条件判断，再选择下一张图：

```ts
// 结构示意：inspectGraph / executeGraph / reviewGraph 是应用已定义的图。
function* taskPlan(request: Request): GraphPlan<Result> {
  const inspected = yield* graphStep(inspectGraph, request);
  if (inspected.needsHuman) return { status: "waiting_for_human" };
  let state = inspected;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = yield* graphStep(executeGraph, state);
    const review = yield* graphStep(reviewGraph, result);
    if (review.complete) return { status: "completed", result };
    state = review.nextInput;
  }
  return { status: "budget_exhausted" };
}
```

上述片段展示应用类型结构，不是可直接运行的业务实现。完整可运行版本见[动态循环](../../examples/control-flow/iteration/README.zh-CN.md)与 [Plan-and-Execute](../../examples/patterns/plan-and-execute/README.zh-CN.md)。

重试需要先区分输入错误、临时基础设施错误和已发生的副作用；仅修改计划不代表预算重置。取消信号由外层 Loop 管理，不能在内部 catch 后继续执行其他 Graph。

## 5. 同一 Graph 的固定循环

对于遍历列表、固定次数迭代，可以使用状态式 Loop：

```ts
const definition = loop({
  graph: oneItemGraph,
  maxIterations: items.length,
  bind: (index: number) => items[index]!,
  update: index => index + 1,
  done: index => index === items.length,
});
// items 为空时直接返回，不创建 maxIterations=0 的 Loop。
```

如果不同阶段输入输出类型不同，生成器形式的 `graphStep` 更适合，类型也能沿阶段准确推导。

## 6. 子计划与执行预算

可复用子计划是生成器函数；父计划用 `yield* childPlan(input)`，子计划继续 yield `graphStep`。这些 Graph 仍计入同一个外层 Loop 的预算。不要在每个子计划内另建 Runtime/Loop，导致取消、计数和生命周期彼此脱离。

区别于应用阶段，Worker 内部为实现私有语义操作可以使用 `ctx.run(internalGraph, input)`。它不替代应用 Loop，也不是把多个完整 Agent 藏入 Worker 的默认方式。详见[扩展 Worker](extensions.md)。

## 7. 观察与停止

调用 `runtime.loop` 时传入 `{ signal: AbortSignal.timeout(120_000), onGraph: event => ... }` 可以观察每个阶段的开始、完成和失败。记录 loopId、graphId、iteration、status，业务日志另外保存 taskId 与幂等键。不要在日志中输出完整密钥或未脱敏上下文。

[完整 Graph/Loop API](../worker-api/graph-loops.zh-CN.md) · [并行](../worker-api/parallel.zh-CN.md) · [恢复](reliability.md)
