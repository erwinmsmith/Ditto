import type { NodeType } from "@ditto/core";
import { runRagFlow, runSkillFlow, runMcpFlow, runToolCallFlow,
  type McpFlowInput, type RuntimeFlowResult, type InteractionFlowResult } from "@ditto/core/runtime";
import { createInteractionWorker, createReadOnlyCommandTools, type InteractionMcpOutput,
  type ReadOnlyCommandToolOptions, type RegisteredTool } from "@ditto/core/worker/interaction";
import { inferTrajectoryNode } from "@ditto/core/worker/infer";
import { ProviderRegistry } from "@ditto/core/worker/infer/providers";
import type { MemoryGetInput } from "@ditto/core/worker/memory";
import type { ToolCall } from "@ditto/core";
import type { ActionDescriptor, ActionRequest } from "@ditto/core/worker/infer";

const node: NodeType = inferTrajectoryNode.type;
const input: MemoryGetInput = { ids: ["m1"] };
void node;
void input;
void runRagFlow;
void runSkillFlow;
void runMcpFlow;
void runToolCallFlow;
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
