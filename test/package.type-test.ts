import type { NodeType } from "@ditto/core";
import { runRagFlow, runSkillFlow, runMcpFlow, runToolCallFlow } from "@ditto/core/runtime";
import { inferTrajectoryNode } from "@ditto/core/worker/infer";
import { ProviderRegistry } from "@ditto/core/worker/infer/providers";
import type { MemoryRetrieveInput } from "@ditto/core/worker/memory";

const node: NodeType = inferTrajectoryNode.type;
const input: MemoryRetrieveInput = { selector: { ids: ["m1"] } };
void node;
void input;
void runRagFlow;
void runSkillFlow;
void runMcpFlow;
void runToolCallFlow;
void new ProviderRegistry();
