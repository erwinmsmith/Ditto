# MCP: connect external tool services

MCP integration has three layers: the application opens an SDK connection, a neutral adapter implements Ditto's McpClient, and a Graph calls `INTERACTION.ACT.MCP`. Ditto does not bundle an MCP SDK or start processes automatically from server names.

## 1. Install application dependencies

In your npm application:

```sh
npm install @codesoul-co/ditto @modelcontextprotocol/sdk @modelcontextprotocol/server-filesystem
mkdir -p workspace
printf 'Hello from MCP\n' > workspace/hello.txt
node examples/handbook/mcp.mjs ./workspace hello.txt .
```

The last argument identifies the application directory containing the optional SDK. The complete `.mjs` below starts a local filesystem server, discovers tools, reads an actual file and converts the result to an Observation.

In the source repository, keep these SDKs out of framework runtime dependencies. Install them in a separate application dependency directory and pass that directory as the final argument.

## 2. Complete connection and Graph

<<< ../../examples/handbook/mcp.mjs

Successful output retains `source: "files:read_text_file"`, the original callId and the actual file content. A missing file fails instead of returning an empty successful result.

## 3. Why an adapter is needed

| Interface | Ditto expects | Application responsibility |
| --- | --- | --- |
| listTools(params,options) | Tools and optional nextCursor | Preserve SDK this binding, forward signal, map inputSchema |
| callTool(params,options) | content / structuredContent / references / isError | SDK call options are the third argument; the second is the result schema |
| close | Outside McpClient | Close the client and transport after Runtime drains |

SDK content blocks may include specific multimodal types. Normalize unsupported blocks explicitly or represent them as allowed references. Type assertions do not make incompatible unions into generic messages.

## 4. Discovery and invocation have different results

`{operation:"discover",server:"files"}` returns capabilities. `{operation:"invoke",server:"files",call:{...}}` returns result. Check `operation` before accessing fields. Invocation `result` is ExternalResult, not NodeResult.

Discovery handles pagination. McpRegistry bounds pages and tool counts and rejects repeated cursors and invalid schemas. Large servers can configure `maxDiscoveryPages/maxCapabilities`, but discovery should remain bounded.

## 5. Permissions and boundaries

Sandbox `mcp: ["files"]` allows a server, not individual tools within it. The filesystem server enforces its root directory. For read-only access, filter listTools and reject other names in callTool.

Remote HTTP MCP authentication, TLS, session renewal and connection settings belong to the SDK transport. A trusted controller selects hosts and tokens; do not take them directly from model arguments. The Graph and neutral adapter can remain unchanged when using HTTP transport.

## 6. Add MCP to an Agent Loop

Discover capabilities initially and when the server changes. Convert permitted tools into model action descriptors. INFER only requests an action; validate server, name and schema before the MCP Graph executes it. Write the OBSERVE result into Context, then let the Loop continue, return or escalate.

Use a callId per logical call, plus server-supported idempotency identifiers for side effects. A transport timeout does not guarantee server rollback. Recovery still requires effect reconciliation.

[MCP API](../worker-api/interaction.md) · [Real MCP verification](../../scripts/check-interaction-mcp-live.mjs) · [ReAct](../../examples/patterns/react/README.md)
