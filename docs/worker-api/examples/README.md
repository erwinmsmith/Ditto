# Type-checked Worker API examples

The learning catalog is in [examples](../../../examples/README.md). See the [setup guide](guide.md), [Runtime examples](runtime/README.md) and [database integrations](integrations/README.md).

`graph-loop-worker.ts`, `runtime/graph-loop.ts` and `runtime/placement.ts` execute at module load. The per-API function files below only export functions; importing them does not issue requests. Supply configured application model/database/MCP adapters, then call the function you need. Model calls can consume provider credits, and write/update/delete examples perform those operations.

| File | Reference | Resources |
| --- | --- | --- |
| [context.ts](context.ts) | [CONTEXT](../context.md) | Explicit Context, Redis or ContextStateStore |
| [memory.ts](memory.ts) | [MEMORY](../memory.md) | MemoryResources; filters/cursors/orderBy belong to the adapter |
| [infer.ts](infer.ts) | [INFER](../infer.md) · [Providers](../providers.md) | InferClient/ModelConfig or configuration loaded by setupInfer |
| [interaction.ts](interaction.ts) | [INTERACTION](../interaction.md) | Workspace access; connected MCP client and allowed absolute paths |
| [retrieval.ts](retrieval.ts) | [RETRIEVAL](../retrieval.md) · [Providers](../retrieval-providers.md) | Search/embedding/rerank backends; complete MemoryItem candidates or mapOutput |

Run `npm run typecheck` at the repository root. tsconfig includes these files, while emitted package builds exclude them. These are usage examples, not alternative SDKs or automatic live integration tests. Keep each `// example:` region and the matching API reference aligned when changing signatures.

For an executable local flow, use `npm run example:agent` or `npm run example:tools`. MCP commands are in the [setup guide](guide.md#mcp). Load `.env` explicitly with Node `--env-file=.env` or your application loader. loadRuntimeConfigFile reads YAML and uses the supplied environment; it does not read `.env`.

## Function guide

Objects and constructors below do not automatically execute Graphs. Model/database/MCP parameters are configured application-owned resources.

### memory.ts

| Function / object | Behavior |
| --- | --- |
| [`setupMemory`](memory.ts#L8) | Load configuration and create a MEMORY Worker/Runtime and direct SDK using application-owned store/search resources. |
| [`getMemory`](memory.ts#L17) | Read exact IDs/keys, deduplicate repeated IDs and check NodeResult success. |
| [`queryMemory`](memory.ts#L25) | Read up to two pages ordered by id, pass nextCursor and merge items; the adapter must support this order field. |
| [`searchMemory`](memory.ts#L39) | Use the storage plugin's default search strategy; return full memories and optional scores. |
| [`writeMemory`](memory.ts#L47) | Write a language preference and return its database ID; repeated-key behavior belongs to the adapter. |
| [`updateMemory`](memory.ts#L55) | Replace content and clear metadata by an existing id, demonstrating partial-update semantics. |
| [`deleteMemory`](memory.ts#L63) | Delete IDs and inspect actual deletions; repeated IDs are not reported twice. |
| [`executeMemory`](memory.ts#L71) | Call MEMORY.QUERY through the common execute entry point. |
| [`adaptDatabase`](memory.ts#L77) | Wrap a compatible application adapter as store/search while preserving method this binding. |
| [`memoryErrors`](memory.ts#L92) | Show structured failures for invalid limits and application MemoryError. |
| [`memoryGraph`](memory.ts#L106) | Run MEMORY.GET through a Graph and close Runtime. |
| [`customGet`](memory.ts#L115) | Define a node descriptor returning NOT_CONFIGURED without accessing a database. |

### infer.ts

| Function / object | Behavior |
| --- | --- |
| [`setupInfer`](infer.ts#L11) | Load YAML/environment configuration and create a Worker, Runtime and direct SDK with a shared cache. |
| [`sample`](infer.ts#L20) | Sample once and inspect Message, finishReason and usage. |
| [`sampleActions`](infer.ts#L30) | Declare read_text to the model; generate a request without executing a file read. |
| [`trajectory`](infer.ts#L39) | Run a CoT trajectory and check both outer success and inner completed status. |
| [`strategyRequests`](infer.ts#L52) | Construct CoT, Long CoT, ToT, GoT and self-consistency requests without model calls. |
| [`reflectModes`](infer.ts#L64) | Evaluate or revise a candidate using critique/verify/revise mode. |
| [`deliberateModes`](infer.ts#L76) | Process candidates using select/merge/consensus/debate; selectCount applies only to select. |
| [`cacheApis`](infer.ts#L90) | Write and read cache entries, then invalidate by key/tag/namespace. |
| [`executeInfer`](infer.ts#L102) | Sample through execute with a per-call timeoutMs. |
| [`streamApis`](infer.ts#L107) | Consume all four reasoning streams and terminal outputs; this makes multiple model calls. |
| [`cancelInfer`](infer.ts#L129) | Pass an already-aborted signal and observe cancelled without issuing a model request. |
| [`cacheProviderApi`](infer.ts#L136) | Call cache write/lookup/invalidate directly; return raw outputs without NodeResult. |
| [`refineStrategy`](infer.ts#L145) | Define a strategy that drafts, revises, deliberates and records public decision steps; inject before use. |
| [`providerRegistryApis`](infer.ts#L159) | Register, resolve, invoke and unregister a model provider. |
| [`providerStream`](infer.ts#L169) | Consume provider streaming, falling back to invoke when streaming is unsupported. |
| [`httpModelProvider`](infer.ts#L180) | Construct an HTTP provider from supplied configuration; construction does not send requests. |
| [`sampleDescriptor`](infer.ts#L188) | Wrap SDK sample as a NodeDefinition without automatic registration/execution. |

### interaction.ts

| Function / object | Behavior |
| --- | --- |
| [`readTextTool`](interaction.ts#L9) | Define a workspace reader with argument validation, capability metadata and Sandbox access. |
| [`consoleSink`](interaction.ts#L22) | Define a console sink that prints messages and returns an accepted receipt. |
| [`setupInteraction`](interaction.ts#L30) | Register a file tool, connected MCP client and output sink with a Worker/Runtime. |
| [`interactionNodes`](interaction.ts#L38) | Compose registries, createInteractionNodes and defineWorker. |
| [`interactionHandlers`](interaction.ts#L45) | Compose the four Interaction nodes using handler factories. |
| [`toolRegistryApis`](interaction.ts#L57) | Register, list allowed tools, invoke and unregister inside a real WorkerContext. |
| [`invokeTool`](interaction.ts#L68) | Read README.md through Runtime; ExternalResult has no output wrapper. |
| [`mcpRegistryApis`](interaction.ts#L78) | Discover and invoke read_text_file with McpRegistry, then unregister the client. |
| [`invokeMcp`](interaction.ts#L90) | Discover and read through Runtime while distinguishing both response shapes. |
| [`observeApis`](interaction.ts#L104) | Compare pure normalization with OBSERVE using supplied outcomes, without external requests. |
| [`outputApi`](interaction.ts#L115) | Send structured messages and artifact references to the console sink; this does not create artifact files. |
| [`missingRecordTool`](interaction.ts#L126) | Define a NOT_FOUND tool outcome to illustrate business failure. |
| [`rejectedSink`](interaction.ts#L130) | Define a sink returning a rejected delivery receipt. |
| [`interactionGraph`](interaction.ts#L135) | Read README.md and package.json through Graph + Loop and output two observations. |
| [`observationDefinition`](interaction.ts#L154) | Define an OBSERVE node descriptor without registration/execution. |
| [`mcpClientAdapter`](interaction.ts#L157) | Wrap a neutral MCP client, preserving this binding and optional fields. |

### retrieval.ts

| Function / object | Behavior |
| --- | --- |
| [`request`](retrieval.ts#L16) | Define request data: agent memory query, kb target, limit=5; no execution. |
| [`setupRetrieval`](retrieval.ts#L19) | Register the optional Worker and logical target/strategy and create the direct SDK. |
| [`retrievalSearch`](retrieval.ts#L28) | Search the same backend through SDK and Runtime and inspect candidates. |
| [`registryResolve`](retrieval.ts#L39) | Resolve a target's default strategy provider and inspect raw results. |
| [`cancelRetrieval`](retrieval.ts#L46) | Pass AbortSignal as search's third argument and fallback defaults as the second. |
| [`embeddingApis`](retrieval.ts#L54) | Compare embed with batched embedContents and validate vector dimensions. |
| [`httpEmbedding`](retrieval.ts#L62) | Create a real HTTP embedding provider from environment and use YAML batch configuration. |
| [`externalVector`](retrieval.ts#L72) | Embed externally before passing the vector to database search. |
| [`nativeVector`](retrieval.ts#L76) | Send the raw query to a backend with built-in embedding. |
| [`precomputedVector`](retrieval.ts#L79) | Search using an existing vector after dimension validation. |
| [`textSearch`](retrieval.ts#L84) | Wrap native database text search without embedding. |
| [`hybridSearch`](retrieval.ts#L89) | Run vector and keyword branches concurrently and combine with weighted RRF. |
| [`rerankApis`](retrieval.ts#L97) | Create a cosine reranker from embeddings and compare indexes/scores with mapped candidates. |
| [`rerankSearch`](retrieval.ts#L104) | Expand the recall pool, rerank with an injected provider and return the requested count. |
| [`sqlSearch`](retrieval.ts#L110) | Create a PostgreSQL full-text adapter with injected query and bound text/tenant parameters. |
| [`milvusSearch`](retrieval.ts#L128) | Adapt Milvus requests/responses with injected SDK search, namespaces and complete MemoryItem records. |
| [`nativeMemoryInRetrieval`](retrieval.ts#L140) | Convert a native MemorySearchProvider into a retrieval provider and back into Memory results. |
| [`nativeMemoryWithNamespace`](retrieval.ts#L147) | Map Retrieval namespace to the adapter's tenant filter; this does not replace authentication. |
| [`localMemoryPipeline`](retrieval.ts#L160) | Reuse a retrieval pipeline inside MEMORY without starting a RETRIEVAL Worker. |
| [`delegatedMemory`](retrieval.ts#L168) | Delegate MEMORY.SEARCH to Runtime RETRIEVAL.SEARCH using same-process routing. |
| [`mapTextCandidates`](retrieval.ts#L180) | Map complete candidate business data to MemoryItem; ID/snippet indexes need batch hydration. |
| [`retrievalDescriptor`](retrieval.ts#L188) | Wrap the retrieval SDK as a NodeDefinition while retaining SDK validation and NodeResult. |

### context.ts

| Function / object | Behavior |
| --- | --- |
| [`setupContext`](context.ts) | Create the direct SDK and Worker; see CONTEXT for configuration. |
| [`loadContext`](context.ts) | Load messages, items and references. |
| [`selectContext`](context.ts) | Select context for inference or memory. |
| [`updateContext`](context.ts) | Apply incremental changes and preserve provenance. |
| [`compressContext`](context.ts) | Compress against a budget. |
| [`executeContext`](context.ts) | Use the common execute entry point. |
| [`cachedContext`](context.ts) | Invoke all four Context nodes in cache mode. |
| [`redisStore`](context.ts) | Configure Redis storage and explicit versions. |
| [`contextServices`](context.ts) | Inject custom Context services. |
| [`ragContext`](context.ts) | Configure a RAG selection strategy. |
| [`contextRetrieval`](context.ts) | Reuse a RETRIEVAL provider for Context. |
| [`contextToInfer`](context.ts) | Convert selected Context for INFER. |
| [`memoryToContext`](context.ts) | Compose Memory and Context in a Graph. |
| [`contextFlows`](context.ts) | Run predefined RAG and Skill flows. |
| [`contextErrors`](context.ts) | Demonstrate Context failure paths. |
| [`directStrategies`](context.ts) | Reuse built-in strategies directly. |
| [`customContextLoad`](context.ts) | Define a custom load node descriptor. |
| [`contextToMemory`](context.ts) | Write selected content into long-term MEMORY. |
| [`toolToCachedContext`](context.ts) | Write tool observations into cached Context. |
| [`remoteContextRetrieval`](context.ts) | Delegate search to a separate RETRIEVAL Worker. |

## Suggested order

1. Start with the [complete examples](guide.md) without optional services.
2. Choose a function for a Worker and inject resources matching its signature. Close Runtime returned by setupMemory/setupInfer/setupInteraction/setupRetrieval.
3. Run `npm run typecheck` after changes. Running `node docs/worker-api/examples/memory.ts` alone does not call its exported functions.

[Database integrations](integrations/README.md) cover Redis Context and SQL/Milvus Memory. [Runtime examples](runtime/README.md) cover a first Graph, custom Workers, events, artifacts, cleanup and RAG/Skill/Tool/MCP/ReAct flows. The per-function modules are safe to import without issuing requests; consult each directory for executable entry points.
