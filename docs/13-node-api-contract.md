# Ditto 节点 API 规范

> 当前适用范围：本文件是原始评审基线，18 个语义 Node 的名称和输入输出仍有效。第 9–10 节的空类、一级聚合类型与继承规则仅作为历史设计保留，当前实现已删除；Node 使用函数 handler / defineNode，详见 [当前架构](architecture.md)。

> 版本：`1.0`  
> 语言：TypeScript  
> 状态：固定接口评审版  
> 范围：节点类型、输入、输出与空类

## 1. 接口边界

本规范固定以下内容：

- 4 个一级节点及 18 个二级节点的名称；
- 所有公共基础类型；
- 每个二级节点唯一对应的输入与输出；
- 二级节点空抽象类；
- 一级节点的聚合输入、输出与空抽象类。

本规范不定义以下内容：

- 业务规则；
- 节点内部算法；
- 节点编排与调用顺序；
- 模型、工具、存储、通信和部署机制；
- 错误、重试、超时、状态机和资源调度；
- Hypha 或其他框架适配。

实现机制不得改变本文规定的节点名、字段名和输入输出对应关系。

## 2. 节点体系

```text
REASONING
├─ INFER
├─ DELIBERATE
├─ REFLECT
└─ SAMPLE

CONTEXT
├─ LOAD
├─ SELECT
├─ UPDATE
├─ COMPRESS
└─ RESET

MEMORY
├─ RETRIEVE
├─ WRITE
├─ UPDATE
├─ CONSOLIDATE
└─ EVICT

INTERACTION
├─ ACT
├─ OBSERVE
├─ COMMUNICATE
└─ OUTPUT
```

边界说明：

- 一级节点是分类和聚合边界，不表示具体实现方式。
- 二级节点是最小 API 单元，每个二级节点拥有独立输入、输出和空类。
- 节点类型使用全限定名称，避免 `CONTEXT.UPDATE` 与 `MEMORY.UPDATE` 混淆。

## 3. 公共基础类型

### 3.1 JSON

```ts
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = Readonly<Record<string, JsonValue>>;
```

### 3.2 Message

```ts
export type MessageRole =
  | "system"
  | "user"
  | "assistant"
  | "tool";

export interface Reference {
  uri: string;
  mediaType?: string;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "json"; data: JsonValue }
  | { type: "reference"; reference: Reference };

export type MessageContent =
  | string
  | JsonValue
  | readonly MessagePart[];

export interface Message {
  role: MessageRole;
  content: MessageContent;
  name?: string;
}
```

`Message` 只表示通用消息，不包含业务状态、推理机制或传输机制。

### 3.3 Context

```ts
export interface ContextItem {
  id: string;
  content: MessageContent;
}

export interface Context {
  items: readonly ContextItem[];
}

export type ContextSource = Message | Reference;
```

`Context` 表示当前上下文集合，不规定其来源、选择方法或生命周期。

### 3.4 Memory

```ts
export interface MemoryDraft {
  message: Message;
}

export interface MemoryItem {
  id: string;
  message: Message;
}

export interface MemoryReference {
  id: string;
}
```

`MemoryDraft` 用于新增输入；`MemoryItem` 表示带标识的记忆；`MemoryReference` 只引用记忆。

### 3.5 Interaction

```ts
export interface Action {
  name: string;
  arguments: JsonObject;
}

export interface Observation {
  source: string;
  message: Message;
}

export interface Recipient {
  id: string;
  channel?: string;
}
```

## 4. REASONING 输入输出

REASONING 节点只接收和返回通用消息结构，不包含业务结果类型。

### 4.1 INFER

```ts
export interface InferInput {
  messages: readonly Message[];
}

export type InferOutput = Message;
```

### 4.2 DELIBERATE

```ts
export interface DeliberateInput {
  messages: readonly Message[];
}

export type DeliberateOutput = Message;
```

### 4.3 REFLECT

```ts
export interface ReflectInput {
  message: Message;
  context?: readonly Message[];
}

export type ReflectOutput = Message;
```

### 4.4 SAMPLE

```ts
export interface SampleInput {
  messages: readonly Message[];
  count: number;
}

export type SampleOutput = readonly Message[];
```

## 5. CONTEXT 输入输出

CONTEXT 节点统一返回 `Context`，不规定上下文如何加载、选择、更新、压缩或重置。

### 5.1 LOAD

```ts
export interface ContextLoadInput {
  sources: readonly ContextSource[];
}

export type ContextLoadOutput = Context;
```

### 5.2 SELECT

```ts
export interface ContextSelectInput {
  context: Context;
  query: Message;
}

export type ContextSelectOutput = Context;
```

### 5.3 UPDATE

```ts
export interface ContextUpdateInput {
  context: Context;
  items: readonly ContextItem[];
}

export type ContextUpdateOutput = Context;
```

### 5.4 COMPRESS

```ts
export interface ContextCompressInput {
  context: Context;
}

export type ContextCompressOutput = Context;
```

### 5.5 RESET

```ts
export interface ContextResetInput {
  context: Context;
}

export type ContextResetOutput = Context;
```

## 6. MEMORY 输入输出

MEMORY 节点只处理通用记忆结构，不规定持久化、检索或淘汰机制。

### 6.1 RETRIEVE

```ts
export interface MemoryRetrieveInput {
  query: Message;
}

export type MemoryRetrieveOutput = readonly MemoryItem[];
```

### 6.2 WRITE

```ts
export interface MemoryWriteInput {
  memories: readonly MemoryDraft[];
}

export type MemoryWriteOutput = readonly MemoryItem[];
```

### 6.3 UPDATE

```ts
export interface MemoryUpdateInput {
  memories: readonly MemoryItem[];
}

export type MemoryUpdateOutput = readonly MemoryItem[];
```

### 6.4 CONSOLIDATE

```ts
export interface MemoryConsolidateInput {
  memories: readonly MemoryItem[];
}

export type MemoryConsolidateOutput = readonly MemoryItem[];
```

### 6.5 EVICT

```ts
export interface MemoryEvictInput {
  memories: readonly MemoryReference[];
}

export type MemoryEvictOutput = readonly MemoryReference[];
```

## 7. INTERACTION 输入输出

INTERACTION 节点统一返回 `Message`，不规定动作执行、观察转换、消息传递或最终输出机制。

### 7.1 ACT

```ts
export interface InteractionActInput {
  action: Action;
}

export type InteractionActOutput = Message;
```

### 7.2 OBSERVE

```ts
export interface InteractionObserveInput {
  observation: Observation;
}

export type InteractionObserveOutput = Message;
```

### 7.3 COMMUNICATE

```ts
export interface InteractionCommunicateInput {
  message: Message;
  recipients: readonly Recipient[];
}

export type InteractionCommunicateOutput = Message;
```

### 7.4 OUTPUT

```ts
export interface InteractionOutputInput {
  message: Message;
}

export type InteractionOutputOutput = Message;
```

## 8. 节点契约映射

`NodeContractMap` 是节点名与输入输出的唯一映射表。

```ts
export interface NodeContract<TInput, TOutput> {
  input: TInput;
  output: TOutput;
}

export interface NodeContractMap {
  "REASONING.INFER": NodeContract<InferInput, InferOutput>;
  "REASONING.DELIBERATE": NodeContract<DeliberateInput, DeliberateOutput>;
  "REASONING.REFLECT": NodeContract<ReflectInput, ReflectOutput>;
  "REASONING.SAMPLE": NodeContract<SampleInput, SampleOutput>;

  "CONTEXT.LOAD": NodeContract<ContextLoadInput, ContextLoadOutput>;
  "CONTEXT.SELECT": NodeContract<ContextSelectInput, ContextSelectOutput>;
  "CONTEXT.UPDATE": NodeContract<ContextUpdateInput, ContextUpdateOutput>;
  "CONTEXT.COMPRESS": NodeContract<ContextCompressInput, ContextCompressOutput>;
  "CONTEXT.RESET": NodeContract<ContextResetInput, ContextResetOutput>;

  "MEMORY.RETRIEVE": NodeContract<MemoryRetrieveInput, MemoryRetrieveOutput>;
  "MEMORY.WRITE": NodeContract<MemoryWriteInput, MemoryWriteOutput>;
  "MEMORY.UPDATE": NodeContract<MemoryUpdateInput, MemoryUpdateOutput>;
  "MEMORY.CONSOLIDATE": NodeContract<MemoryConsolidateInput, MemoryConsolidateOutput>;
  "MEMORY.EVICT": NodeContract<MemoryEvictInput, MemoryEvictOutput>;

  "INTERACTION.ACT": NodeContract<InteractionActInput, InteractionActOutput>;
  "INTERACTION.OBSERVE": NodeContract<InteractionObserveInput, InteractionObserveOutput>;
  "INTERACTION.COMMUNICATE": NodeContract<
    InteractionCommunicateInput,
    InteractionCommunicateOutput
  >;
  "INTERACTION.OUTPUT": NodeContract<InteractionOutputInput, InteractionOutputOutput>;
}

export type L2NodeType = keyof NodeContractMap;

export type InputOf<TNode extends L2NodeType> =
  NodeContractMap[TNode]["input"];

export type OutputOf<TNode extends L2NodeType> =
  NodeContractMap[TNode]["output"];
```

该映射保证节点名、输入和输出在 TypeScript 类型层一一对应。

## 9. 二级节点空类

### 9.1 基类

```ts
export abstract class BaseNode<TNode extends L2NodeType> {
  abstract readonly type: TNode;

  abstract execute(
    input: InputOf<TNode>,
  ): Promise<OutputOf<TNode>>;
}
```

### 9.2 REASONING

```ts
export abstract class InferNode
  extends BaseNode<"REASONING.INFER"> {}

export abstract class DeliberateNode
  extends BaseNode<"REASONING.DELIBERATE"> {}

export abstract class ReflectNode
  extends BaseNode<"REASONING.REFLECT"> {}

export abstract class SampleNode
  extends BaseNode<"REASONING.SAMPLE"> {}
```

### 9.3 CONTEXT

```ts
export abstract class ContextLoadNode
  extends BaseNode<"CONTEXT.LOAD"> {}

export abstract class ContextSelectNode
  extends BaseNode<"CONTEXT.SELECT"> {}

export abstract class ContextUpdateNode
  extends BaseNode<"CONTEXT.UPDATE"> {}

export abstract class ContextCompressNode
  extends BaseNode<"CONTEXT.COMPRESS"> {}

export abstract class ContextResetNode
  extends BaseNode<"CONTEXT.RESET"> {}
```

### 9.4 MEMORY

```ts
export abstract class MemoryRetrieveNode
  extends BaseNode<"MEMORY.RETRIEVE"> {}

export abstract class MemoryWriteNode
  extends BaseNode<"MEMORY.WRITE"> {}

export abstract class MemoryUpdateNode
  extends BaseNode<"MEMORY.UPDATE"> {}

export abstract class MemoryConsolidateNode
  extends BaseNode<"MEMORY.CONSOLIDATE"> {}

export abstract class MemoryEvictNode
  extends BaseNode<"MEMORY.EVICT"> {}
```

### 9.5 INTERACTION

```ts
export abstract class InteractionActNode
  extends BaseNode<"INTERACTION.ACT"> {}

export abstract class InteractionObserveNode
  extends BaseNode<"INTERACTION.OBSERVE"> {}

export abstract class InteractionCommunicateNode
  extends BaseNode<"INTERACTION.COMMUNICATE"> {}

export abstract class InteractionOutputNode
  extends BaseNode<"INTERACTION.OUTPUT"> {}
```

空类只绑定节点名与输入输出，不包含实现。

## 10. 一级节点聚合类型与空类

```ts
export type L1NodeType =
  | "REASONING"
  | "CONTEXT"
  | "MEMORY"
  | "INTERACTION";

export type ReasoningNodeType = Extract<
  L2NodeType,
  `REASONING.${string}`
>;

export type ContextNodeType = Extract<
  L2NodeType,
  `CONTEXT.${string}`
>;

export type MemoryNodeType = Extract<
  L2NodeType,
  `MEMORY.${string}`
>;

export type InteractionNodeType = Extract<
  L2NodeType,
  `INTERACTION.${string}`
>;

export interface NodeRequest<TNode extends L2NodeType> {
  node: TNode;
  input: InputOf<TNode>;
}

export interface NodeResponse<TNode extends L2NodeType> {
  node: TNode;
  output: OutputOf<TNode>;
}

export abstract class BaseL1Node<
  TNode extends L2NodeType,
> {
  abstract execute<TSelected extends TNode>(
    request: NodeRequest<TSelected>,
  ): Promise<NodeResponse<TSelected>>;
}

export abstract class ReasoningNode
  extends BaseL1Node<ReasoningNodeType> {}

export abstract class ContextNode
  extends BaseL1Node<ContextNodeType> {}

export abstract class MemoryNode
  extends BaseL1Node<MemoryNodeType> {}

export abstract class InteractionNode
  extends BaseL1Node<InteractionNodeType> {}
```

一级节点空类只聚合所属二级节点的类型，不规定调度、路由或部署实现。

## 11. 输入输出总表

| 一级节点 | 二级节点 | 输入 | 输出 |
|---|---|---|---|
| REASONING | INFER | `InferInput` | `Message` |
| REASONING | DELIBERATE | `DeliberateInput` | `Message` |
| REASONING | REFLECT | `ReflectInput` | `Message` |
| REASONING | SAMPLE | `SampleInput` | `Message[]` |
| CONTEXT | LOAD | `ContextLoadInput` | `Context` |
| CONTEXT | SELECT | `ContextSelectInput` | `Context` |
| CONTEXT | UPDATE | `ContextUpdateInput` | `Context` |
| CONTEXT | COMPRESS | `ContextCompressInput` | `Context` |
| CONTEXT | RESET | `ContextResetInput` | `Context` |
| MEMORY | RETRIEVE | `MemoryRetrieveInput` | `MemoryItem[]` |
| MEMORY | WRITE | `MemoryWriteInput` | `MemoryItem[]` |
| MEMORY | UPDATE | `MemoryUpdateInput` | `MemoryItem[]` |
| MEMORY | CONSOLIDATE | `MemoryConsolidateInput` | `MemoryItem[]` |
| MEMORY | EVICT | `MemoryEvictInput` | `MemoryReference[]` |
| INTERACTION | ACT | `InteractionActInput` | `Message` |
| INTERACTION | OBSERVE | `InteractionObserveInput` | `Message` |
| INTERACTION | COMMUNICATE | `InteractionCommunicateInput` | `Message` |
| INTERACTION | OUTPUT | `InteractionOutputInput` | `Message` |

## 12. 固定规则

1. 节点名必须使用 `NodeContractMap` 中的全限定名称。
2. 每个节点的输入和输出只能由 `InputOf<TNode>` 与 `OutputOf<TNode>` 推导。
3. 实现类必须继承对应空类，或提供完全等价的公开类型。
4. 不得通过 `options`、`metadata` 或任意扩展对象绕过固定字段。
5. 不得在基础类型中加入特定业务字段。
6. 不得在本接口层定义实现机制或流程政策。
7. 新增二级节点必须同时更新 `NodeContractMap`、空类和总表。

## 13. 版本规则

- `1.x` 可以新增可选字段或新节点。
- 删除字段、修改字段类型、修改必填性或改变节点输入输出对应关系，必须升级主版本。
- 实现机制变化但输入输出不变时，不修改 API 版本。
- 本文是接口定义；机制设计应另建文档，不得直接改写已固定接口。

## 14. 结论

本规范只回答三个问题：节点叫什么、接收什么、返回什么。18 个二级节点和 4 个一级节点的类型边界已统一由 `NodeContractMap` 固定，具体机制留待后续讨论。


