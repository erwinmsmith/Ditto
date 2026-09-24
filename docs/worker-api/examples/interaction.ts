import { createDitto, defineWorker, graph, loop, type WorkerContext } from "@codesoul-co/ditto";
import {
  createInteractionWorker, createInteractionNodes, createToolHandler, createMcpHandler,
  createOutputHandler, observeExternalResult, ToolRegistry, McpRegistry,
  interactionObserveNode, type RegisteredTool, type McpClient, type OutputSink,
} from "@codesoul-co/ditto/worker/interaction";

// example: tool
export const readTextTool: RegisteredTool = {
  name: "read_text", description: "Read a workspace text file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  effects: ["read"], requiresApproval: false,
  validate(args) {
    if (!args || typeof args.path !== "string" || !args.path.trim()) throw new Error("path must be a nonempty string");
  },
  async execute(args, context) {
    return { status: "success", content: await context.services.sandbox.readText(args.path as string) };
  },
};

// example: sink
export const consoleSink: OutputSink = {
  async deliver(input) {
    console.log(JSON.stringify({ id: input.deliveryId, message: input.message, artifacts: input.artifacts }));
    return { deliveryId: input.deliveryId, status: "accepted", ...(input.artifacts ? { artifacts: input.artifacts } : {}) };
  },
};

// example: setup
export function setupInteraction(client: McpClient) {
  return createDitto({
    sandbox: { tools: ["read_text"], read: true, mcp: ["files"] },
    workers: [createInteractionWorker({ tools: [readTextTool], mcp: { files: client }, output: consoleSink, concurrency: 8 })],
  }); // client is already connected; the application closes it after runtime.close().
}

// example: nodes
export function interactionNodes(client: McpClient) {
  const tools = new ToolRegistry(); tools.register(readTextTool);
  const mcp = new McpRegistry(); mcp.register("files", client);
  return defineWorker({ type: "INTERACTION", nodes: createInteractionNodes({ tools, mcp, output: consoleSink }) });
}

// example: handlers
export function interactionHandlers(client: McpClient) {
  const tools = new ToolRegistry(); tools.register(readTextTool);
  const mcp = new McpRegistry(); mcp.register("files", client);
  return defineWorker({ type: "INTERACTION", nodes: {
    "INTERACTION.ACT.TOOL": createToolHandler(tools),
    "INTERACTION.ACT.MCP": createMcpHandler(mcp),
    "INTERACTION.OBSERVE": async input => observeExternalResult(input),
    "INTERACTION.OUTPUT": createOutputHandler(consoleSink),
  } });
}

// example: registry
export async function toolRegistryApis(context: WorkerContext<unknown, unknown>) {
  const tools = new ToolRegistry();
  const unregister = tools.register(readTextTool);
  const definitions = tools.list(context); // Only tools allowed by context.services.sandbox.
  try {
    const result = await tools.call({ id: "read-1", name: "read_text", arguments: { path: "README.md" } }, context);
    return { definitions, result };
  } finally { unregister(); } // true on first removal, false afterwards; does not close tool resources.
}

// example: invokeTool
export async function invokeTool() {
  const runtime = createDitto({ sandbox: { tools: ["read_text"], read: true }, workers: [createInteractionWorker({ tools: [readTextTool] })] });
  try {
    const result = await runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "read-1", name: "read_text", arguments: { path: "README.md" } } });
    if (result.status !== "success") throw new Error(result.error?.code ?? result.status);
    return result.content; // Direct ExternalResult; no .output wrapper.
  } finally { await runtime.close(); }
}

// example: mcpRegistry
export async function mcpRegistryApis(client: McpClient, absoluteFilePath: string) {
  const runtime = createDitto({ sandbox: { mcp: ["files"] } });
  const mcp = new McpRegistry({ maxDiscoveryPages: 10, maxCapabilities: 200 });
  const unregister = mcp.register("files", client);
  try {
    const discovery = await mcp.execute({ operation: "discover", server: "files" }, runtime.services.sandbox);
    const result = await mcp.execute({ operation: "invoke", server: "files", call: { id: "mcp-1", name: "read_text_file", arguments: { path: absoluteFilePath } } }, runtime.services.sandbox);
    return { discovery, result };
  } finally { unregister(); await runtime.close(); }
}

// example: invokeMcp
export async function invokeMcp(client: McpClient, absoluteFilePath: string) {
  const runtime = setupInteraction(client);
  try {
    const discovery = await runtime.invoke("INTERACTION.ACT.MCP", { operation: "discover", server: "files" });
    if (discovery.operation !== "discover") throw new Error("Expected discovery response");
    const response = await runtime.invoke("INTERACTION.ACT.MCP", {
      operation: "invoke", server: "files", call: { id: "mcp-read", name: "read_text_file", arguments: { path: absoluteFilePath } },
    });
    if (response.operation !== "invoke") throw new Error("Expected invocation response");
    return { capabilities: discovery.capabilities, result: response.result };
  } finally { await runtime.close(); }
}

// example: observe
export async function observeApis() {
  const result = { callId: "read-1", source: "read_text", status: "success" as const, content: "file text" };
  const local = observeExternalResult({ result });
  const runtime = createDitto({ workers: [createInteractionWorker()] });
  try {
    const routed = await runtime.invoke("INTERACTION.OBSERVE", { result });
    return { local, routed }; // message = { role: "tool", name: "read_text", content: "file text" }
  } finally { await runtime.close(); }
}

// example: output
export async function outputApi() {
  const runtime = createDitto({ workers: [createInteractionWorker({ output: consoleSink })] });
  try {
    return await runtime.invoke("INTERACTION.OUTPUT", {
      deliveryId: "report-1", message: { role: "assistant", content: { summary: "Complete", count: 2 } },
      artifacts: [{ name: "report", reference: { uri: "urn:report:1", mediaType: "application/json" } }],
    }); // { deliveryId: "report-1", status: "accepted", artifacts: [...] }
  } finally { await runtime.close(); }
}

// example: failure
export const missingRecordTool: RegisteredTool = {
  name: "lookup", inputSchema: { type: "object" }, validate() {},
  async execute() { return { status: "failed", error: { code: "NOT_FOUND", message: "No matching record", retryable: false } }; },
};
export const rejectedSink: OutputSink = {
  async deliver(input) { return { deliveryId: input.deliveryId, status: "rejected", error: { code: "DELIVERY_REJECTED", message: "The destination rejected the result" } }; },
};

// example: graph
export async function interactionGraph() {
  const runtime = createDitto({ sandbox: { tools: ["read_text"], read: true }, workers: [createInteractionWorker({ tools: [readTextTool], output: consoleSink })] });
  const plan = graph<{ path: string; id: string }>("read-and-deliver")
    .node("read", "INTERACTION.ACT.TOOL", [], input => ({ call: { id: input.id, name: "read_text", arguments: { path: input.path } } }))
    .node("observe", "INTERACTION.OBSERVE", ["read"], (_input, { read }) => ({ result: read }))
    .node("output", "INTERACTION.OUTPUT", ["observe"], (input, { observe }) => {
      if (observe.status !== "success") throw new Error(observe.error?.code ?? observe.status);
      return { deliveryId: `${input.id}:delivery`, message: { role: "assistant", content: observe.message.content } };
    });
  const paths = ["README.md", "package.json"];
  try {
    return await runtime.loop(loop({ graph: plan, maxIterations: paths.length,
      bind: (index: number) => ({ path: paths[index]!, id: `read:${index}` }),
      update: index => index + 1, done: index => index === paths.length,
    }), 0);
  } finally { await runtime.close(); }
}

// example: scaffold
export const observationDefinition = interactionObserveNode.define("INTERACTION", async input => observeExternalResult(input));

// example: mcpAdapter
export function mcpClientAdapter(client: McpClient): McpClient {
  return {
    listTools: (params, options) => client.listTools(params, options),
    async callTool(params, options) {
      const result = await client.callTool(params, options);
      return {
        ...(result.content === undefined ? {} : { content: result.content }),
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        ...(result.references === undefined ? {} : { references: result.references }),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    },
  };
}
