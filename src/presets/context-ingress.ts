import { createHash } from "node:crypto";
import type {
  ContextIngress, ContextIngressSource, JsonObject, JsonValue,
} from "../contracts/common.js";
import type { ContextRagRankOutput } from "../worker/context/contracts.js";
import type { InteractionMcpOutput, InteractionToolOutput } from "../worker/interaction/contracts.js";
import type { MemoryRagRankOutput, MemorySkillOutput } from "../worker/memory/contracts.js";

export interface ContextIngressAdapter<Source extends ContextIngressSource, Output> {
  readonly source: Source;
  readonly target: "CONTEXT.UPDATE";
  map(output: Output): readonly ContextIngress[];
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export const memorySkillContextUpdate: ContextIngressAdapter<"MEMORY.SKILL", MemorySkillOutput> = Object.freeze({
  source: "MEMORY.SKILL",
  target: "CONTEXT.UPDATE",
  map: (skill: MemorySkillOutput): readonly ContextIngress[] => [{
    id: stableId("skill", [skill.name, skill.version ?? null]),
    sourceNode: "MEMORY.SKILL",
    content: skill.instructions,
    metadata: {
      ...(skill.metadata ?? {}),
      name: skill.name,
      ...(skill.version === undefined ? {} : { version: skill.version }),
    },
  }],
});

export const contextRagContextUpdate: ContextIngressAdapter<"CONTEXT.RAG.RANK", ContextRagRankOutput> = Object.freeze({
  source: "CONTEXT.RAG.RANK",
  target: "CONTEXT.UPDATE",
  map: (candidates: ContextRagRankOutput): readonly ContextIngress[] => candidates.map(({ item, score }) => ({
    id: stableId("context-rag", item.id),
    sourceNode: "CONTEXT.RAG.RANK",
    content: item.content,
    ...(item.source ? { reference: item.source } : {}),
    metadata: { ...(item.metadata ?? {}), itemId: item.id, ...(score === undefined ? {} : { score }) },
  })),
});

export const memoryRagContextUpdate: ContextIngressAdapter<"MEMORY.RAG.RANK", MemoryRagRankOutput> = Object.freeze({
  source: "MEMORY.RAG.RANK",
  target: "CONTEXT.UPDATE",
  map: (candidates: MemoryRagRankOutput): readonly ContextIngress[] => candidates.map(({ memory, score }) => ({
    id: stableId("memory-rag", memory.id),
    sourceNode: "MEMORY.RAG.RANK",
    content: memory.message.content,
    metadata: {
      ...(memory.metadata ?? {}),
      memoryId: memory.id,
      ...(memory.key === undefined ? {} : { memoryKey: memory.key }),
      ...(score === undefined ? {} : { score }),
    },
  })),
});

export const interactionToolContextUpdate: ContextIngressAdapter<"INTERACTION.ACT.TOOL", InteractionToolOutput> = Object.freeze({
  source: "INTERACTION.ACT.TOOL",
  target: "CONTEXT.UPDATE",
  map: (result: InteractionToolOutput): readonly ContextIngress[] => [{
    id: stableId("tool", result),
    sourceNode: "INTERACTION.ACT.TOOL",
    content: result.content,
    ...(result.reference ? { reference: result.reference } : {}),
    metadata: { ...(result.metadata ?? {}), source: result.source },
  }],
});

export const interactionMcpContextUpdate: ContextIngressAdapter<"INTERACTION.ACT.MCP", InteractionMcpOutput> = Object.freeze({
  source: "INTERACTION.ACT.MCP",
  target: "CONTEXT.UPDATE",
  map: (output: InteractionMcpOutput): readonly ContextIngress[] => {
    if (output.operation === "invoke") {
      return [{
        id: stableId("mcp", output.result),
        sourceNode: "INTERACTION.ACT.MCP",
        content: output.result.content,
        ...(output.result.reference ? { reference: output.result.reference } : {}),
        metadata: { ...(output.result.metadata ?? {}), source: output.result.source },
      }];
    }
    const capabilities: JsonValue = output.capabilities.map((capability) => ({
      server: capability.server,
      name: capability.name,
      ...(capability.description === undefined ? {} : { description: capability.description }),
      ...(capability.inputSchema === undefined ? {} : { inputSchema: capability.inputSchema }),
    }));
    const metadata: JsonObject = { operation: "discover" };
    return [{
      id: stableId("mcp-discover", capabilities),
      sourceNode: "INTERACTION.ACT.MCP",
      content: capabilities,
      metadata,
    }];
  },
});

export interface PredefinedContextFlowMap {
  "memory.skill-context.update": typeof memorySkillContextUpdate;
  "context.rag-context.update": typeof contextRagContextUpdate;
  "memory.rag-context.update": typeof memoryRagContextUpdate;
  "interaction.act.tool-context.update": typeof interactionToolContextUpdate;
  "interaction.act.mcp-context.update": typeof interactionMcpContextUpdate;
}

export type PredefinedContextFlowId = keyof PredefinedContextFlowMap;
export const predefinedContextFlows: PredefinedContextFlowMap = Object.freeze({
  "memory.skill-context.update": memorySkillContextUpdate,
  "context.rag-context.update": contextRagContextUpdate,
  "memory.rag-context.update": memoryRagContextUpdate,
  "interaction.act.tool-context.update": interactionToolContextUpdate,
  "interaction.act.mcp-context.update": interactionMcpContextUpdate,
});
