# Complete Runtime examples

[简体中文](README.zh-CN.md) · [All examples](../guide.md) · [API reference](../../runtime.md)

Run from the project root with Node 24+ and npm 11+. Install with `npm ci` first. The local entrypoints use public exports without model keys, databases or extra SDKs. graph-loop/placement execute on import; quickstart/api/flows only execute when run directly. Exported MCP/ReAct functions in flows require separately supplied external services.

| File | Purpose | Command |
| --- | --- | --- |
| [quickstart.ts](../../../../examples/quickstart.ts) | YAML behavior settings, CONTEXT.LOAD → SELECT, execution and close | `npm run example:runtime:quickstart` |
| [api.ts](api.ts) | Custom/private nodes, separate replicas, event failures, Artifact/Codec and cleanup | `npm run example:runtime:api` |
| [flows.ts](flows.ts) | Skill loading, actual text RAG and README tool reading; exported MCP/ReAct calls | `npm run example:runtime:flows` |
| [graph-loop.ts](graph-loop.ts) | Two read/count graphs; select the read graph once and repeat the count graph twice; bind nodes to independently configured Worker sandboxes; emit count events | `npm run example:runtime` |
| [placement.ts](placement.ts) | Execute one CONTEXT.LOAD graph through direct calls, a real child-process IPC channel and another child-process HTTP server; exchange addresses and clean up resources | `npm run example:runtime:placement` |

`graph-loop.ts` reads the actual root README.md. Reader permits only read_text and filesystem reads; counter permits only count_text, with no filesystem or command permissions. Output contains two counted events and final iteration=3 state. Counts depend on README content. Graphs define dependencies; execution worker mappings select replicas. The example loads root YAML behavior settings and defines Sandbox policies in code without loading `.env`.

`placement.ts` prints both child PIDs and direct/ipc/http results. IPC requests use the inherited Node channel. HTTP requests use an authenticated loopback socket; only startup/shutdown control messages use the HTTP child's IPC channel. This exercises the network protocol without claiming to connect two physical machines. For deployment across machines, start the HTTP Worker separately and configure its registered address and HTTPS endpoint on the caller. The graph stays unchanged.

Production credentials belong in `.env`; behavior settings such as graphConcurrency and loopMaxIterations belong in root YAML. Inject a SandboxExecutor to execute tools through a container or another environment. Process isolation and cooperative Sandbox checks serve separate purposes.

## Exported function guide

| Function | Purpose |
| --- | --- |
| quickstart | Execute and check LOAD → SELECT |
| textWorker / simpleTextWorker | Actual text processing using defineWorker and extendWorker |
| workerLifecycle | Register replicas, verify private nodes/resources, process events, pause/unregister/close |
| eventFabric | Run consumers, collect failures, unsubscribe |
| artifacts | put/get/delete, inline/reference encoding and cleanup |
| readTextTool / contextFlows | File tool plus Skill → text retrieval → tool → observation → Context |
| mcpFlows | Discover then invoke a tool through a connected MCP client and update Context |
| reactFlow | Bounded ReAct with a configured model/readTextTool; throw on non-completion |
