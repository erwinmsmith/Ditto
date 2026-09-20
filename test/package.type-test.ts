import type { NodeType } from "@ditto/core";
import { runRagFlow, runSkillFlow, runMcpFlow, runToolCallFlow } from "@ditto/core/runtime";
import { inferTrajectoryNode } from "@ditto/core/worker/infer";
import { ProviderRegistry } from "@ditto/core/worker/infer/providers";
import type { MemoryRetrieveInput } from "@ditto/core/worker/memory";
import type { ToolCall } from "@ditto/core";
import type { ActionDescriptor, ActionRequest } from "@ditto/core/worker/infer";

const node: NodeType = inferTrajectoryNode.type;
const input: MemoryRetrieveInput = { selector: { ids: ["m1"] } };
void node;
void input;
void runRagFlow;
void runSkillFlow;
void runMcpFlow;
void runToolCallFlow;
void new ProviderRegistry();
// @ts-expect-error Tool calls require a caller-owned correlation ID.
const missingCallId: ToolCall = { name: "lookup", arguments: {} };
void missingCallId;
const mcpAction: ActionDescriptor = { name: "search", inputSchema: {}, target: { kind: "mcp", server: "docs", toolName: "search" } };
void mcpAction;
// @ts-expect-error Model-produced action requests cannot specify routing.
const routedRequest: ActionRequest = { id: "one", name: "search", arguments: {}, targetNode: "INTERACTION.ACT.MCP" };
void routedRequest;
