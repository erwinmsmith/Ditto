import type { NodeType } from "@codesoul-co/ditto";
import { runRagFlow, runSkillFlow, runMcpFlow, runToolCallFlow,
  type McpFlowInput, type RuntimeFlowResult, type InteractionFlowResult } from "@codesoul-co/ditto/runtime";
import { createInteractionWorker, createReadOnlyCommandTools, type InteractionMcpOutput,
  createBraveWebSearchProvider, createWebSearchTool, type BraveWebSearchProviderOptions,
  type ReadOnlyCommandToolOptions, type RegisteredTool, type WebSearchProvider, type WebSearchResult } from "@codesoul-co/ditto/worker/interaction";
import { inferTrajectoryNode } from "@codesoul-co/ditto/worker/infer";
import { ProviderRegistry } from "@codesoul-co/ditto/worker/infer/providers";
import type { MemoryGetInput } from "@codesoul-co/ditto/worker/memory";
import type { ToolCall } from "@codesoul-co/ditto";
import type { ActionDescriptor, ActionRequest } from "@codesoul-co/ditto/worker/infer";

const node: NodeType = inferTrajectoryNode.type;
const input: MemoryGetInput = { ids: ["m1"] };
void node;
void input;
void runRagFlow;
void runSkillFlow;
void runMcpFlow;
void runToolCallFlow;
void createWebSearchTool;
void createBraveWebSearchProvider;
const webResult: WebSearchResult = { title: "Ditto", url: "https://example.com", snippet: "Core" };
const webProvider: WebSearchProvider = { origin: "https://example.com", async search() { return [webResult]; } };
const braveOptions: BraveWebSearchProviderOptions = { apiKey: "test" };
void webProvider;
void braveOptions;
function checkMcpOverloads(runtime: Parameters<typeof runMcpFlow>[0], input: McpFlowInput): void {
  const union: Promise<RuntimeFlowResult<InteractionMcpOutput> | InteractionFlowResult<InteractionMcpOutput>> = runMcpFlow(runtime, input);
  const discover: Promise<RuntimeFlowResult<Extract<InteractionMcpOutput, { operation: "discover" }>>> = runMcpFlow(runtime,
    { context: input.context, request: { operation: "discover" } });
  const invoke: Promise<InteractionFlowResult<Extract<InteractionMcpOutput, { operation: "invoke" }>>> = runMcpFlow(runtime,
    { context: input.context, request: { operation: "invoke", server: "docs", call: { id: "call", name: "search", arguments: {} } } });
  void union; void discover; void invoke;
}
void checkMcpOverloads;
const commandOptions: ReadOnlyCommandToolOptions = { maxEntries: 200, maxOutputBytes: 32 * 1024 };
const commandTools: readonly RegisteredTool[] = createReadOnlyCommandTools(commandOptions);
void commandTools;
void new ProviderRegistry();
// @ts-expect-error Tool calls require a caller-owned correlation ID.
const missingCallId: ToolCall = { name: "lookup", arguments: {} };
void missingCallId;
const mcpAction: ActionDescriptor = { name: "search", inputSchema: {}, target: { kind: "mcp", server: "docs", toolName: "search" } };
void mcpAction;
// @ts-expect-error Model-produced action requests cannot specify routing.
const routedRequest: ActionRequest = { id: "one", name: "search", arguments: {}, targetNode: "INTERACTION.ACT.MCP" };
void routedRequest;

void createInteractionWorker({ tools: [], mcp: {}, concurrency: 2 });
