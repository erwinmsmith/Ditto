import type { NodeType } from "@ditto/core";
import { contextRagContextUpdate } from "@ditto/core/presets";
import { inferTrajectoryNode } from "@ditto/core/worker/infer";
import { ProviderRegistry } from "@ditto/core/worker/infer/providers";
import type { MemoryRetrieveInput } from "@ditto/core/worker/memory";

const node: NodeType = inferTrajectoryNode.type;
const input: MemoryRetrieveInput = { selector: { ids: ["m1"] } };
void node;
void input;
void contextRagContextUpdate;
void new ProviderRegistry();
