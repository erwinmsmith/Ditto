# Extend Workers and Nodes

Choose the extension layer first: an external operation is usually a Tool, a model protocol is a ModelProvider, storage is a MemoryStore, and a retrieval algorithm is a SearchProvider. Extend Node contracts and Workers when you need a new independently routable semantic operation.

## 1. Choose an extension point

| Requirement | Interface | New Node needed? |
| --- | --- | --- |
| CRM queries or browser actions | RegisteredTool / McpClient | Usually no |
| Database or search algorithm | MemoryStore / MemorySearchProvider | No |
| Model provider | ModelProvider | No |
| Context selection/compression | ContextServices | No |
| New semantics and independently deployed resources | NodeContractMap + defineWorker | Possibly |
| Add an operation to an existing namespace | Contract augmentation + new Worker definition | Possibly; do not mutate a registered object |

## 2. Complete runnable implementation

```sh
node examples/handbook/extensions.ts '  Café 😀  '
```

Expect normalized `Café 😀`, a Unicode code-point length and the current replica's call count.

<<< ../../examples/handbook/extensions.ts

Both semantic nodes belong to the `text` Worker. NORMALIZE is private; ANALYZE is the public entry. External Runtime routing can call only ANALYZE, while its handler uses the same replica's NORMALIZE through `ctx.run`.

## 3. Declare contracts

`declare module "@codesoul-co/ditto/contracts"` augments `NodeContractMap`. Keys are complete semantic leaves and values are `NodeContract<Input,Output>`. Importing the module enables input/output inference in graph.node and runtime.invoke.

Types do not register handlers or validate network JSON. Validate input types, lengths, enums, resource ownership and business permissions at runtime. Avoid bypassing contracts with `as any`.

For a separately published extension, ensure generated `.d.ts` files contain augmentation and the public entry imports it. Declare a compatible main-package peer dependency. Consumers import the extension before using its Nodes.

## 4. Define handlers and resources

`defineNode(workerType,nodeType,handler)` binds ownership, types and execution. `defineWorker({type,nodes,resources,config,dispose})` composes nodes and replica resources.

- `resources()` runs once per local registration. It is synchronous; prepare async connections beforehand or store a Promise that handlers await.
- `config` holds stable configuration, not request state.
- `dispose(resources)` closes replica-owned resources; the application manages shared clients.
- `expose` restricts public nodes; omission exposes all nodes.
- `concurrency` limits replica entry calls, not business transactions or durable queues.

Node namespaces and Worker deployment names may differ. Definitions are immutable. Do not call private executors or `.instantiate()` to bypass Runtime.

## 5. Add nodes to an existing Worker namespace

Built-in definitions do not expose a freely mutable nodes collection. Construct a new definition or compose existing capabilities through public node descriptors and handler factories.

For example, `createInteractionNodes` returns reusable WorkerNodes. A new INTERACTION definition can include them and custom leaves. Augment NodeContractMap and implement each handler first. ToolRegistry/McpRegistry are explicit objects, not tool arrays.

```ts
// Wiring sketch: customNode is already declared in NodeContractMap and implemented.
const worker = defineWorker({
  type: "INTERACTION",
  nodes: {
    ...createInteractionNodes({ tools: toolRegistry, mcp: mcpRegistry, output: sink }),
    "APP.AUDIT.RECORD": customNode,
  },
});
```

This is wiring guidance, assuming customNode and registries are already defined. If created with defineNode, customNode must belong to INTERACTION. Without expose, both sets are public. Define ownership explicitly when replicas need separate registries.

`extendWorker("APP.TEXT",{nodes:{NORMALIZE:handler}})` is construction shorthand using relative names. It creates a new definition; it does not mutate old objects or hot-swap running requests. See [composition](../worker-api/composition.md).

## 6. WorkerContext capabilities

| Field/method | Purpose |
| --- | --- |
| resources / config | Current replica resources and definition configuration |
| services | Runtime config/providers/sandbox |
| signal | Cooperative cancellation passed to SDKs, databases and file reads |
| run | Internal Graph on this replica, including private nodes |
| invoke | Public routing to other Workers |
| emit | Publish an event; acceptance is not consumer completion |
| artifacts | Optional object storage configured by Runtime |
| execution / worker | Execution/node scope and Worker address |

Await work started by a handler. Do not leave detached tasks outside cancellation/lifecycle control or wait for the current Worker's close from inside its own handler.

## 7. Registration, replacement and remote deployment

`runtime.register(definition,{id})` returns a handle. Changing availability prevents subsequent routing but does not undo running work. `unregister` removes routing; `close` releases resources.

Register and health-check a new replica, stop new traffic to the old one, then drain it. Remote Workers use registerRemote and transport adapters. Both sides share contracts and versions; Graphs do not hard-code hosts.

## 8. Validate an extension package

Test valid/invalid inputs, output shapes, resource creation/disposal, replica isolation, private-node rejection, cancellation and concurrency. Then install the actual tarball outside the repository and verify augmentation and execution with no TypeScript paths aliases.

[Composition API](../worker-api/composition.md) · [Deployment](deployment.en.md) · [Retrieval as an extension](retrieval.en.md)
