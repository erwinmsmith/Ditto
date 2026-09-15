import assert from "node:assert/strict";
import test from "node:test";
import {
  contextRagEmbedNode, contextRagRankNode, contextRagRetrieveNode,
  contextSkillNode, contextUpdateNode, interactionMcpNode, interactionToolNode,
  memoryRagEmbedNode, memoryRagRankNode, memoryRagRetrieveNode, memorySkillNode,
  inferTrajectoryNode,
} from "../src/index.js";

test("scaffolds expose semantic identity without embedding implementations", () => {
  assert.deepEqual([
    inferTrajectoryNode.type,
    contextRagEmbedNode.type, contextRagRetrieveNode.type, contextRagRankNode.type, contextSkillNode.type,
    memoryRagEmbedNode.type, memoryRagRetrieveNode.type, memoryRagRankNode.type, memorySkillNode.type,
    interactionToolNode.type, interactionMcpNode.type, contextUpdateNode.type,
  ], [
    "INFER.REASONING.TRAJECTORY",
    "CONTEXT.RAG.EMBED", "CONTEXT.RAG.RETRIEVE", "CONTEXT.RAG.RANK", "CONTEXT.SKILL",
    "MEMORY.RAG.EMBED", "MEMORY.RAG.RETRIEVE", "MEMORY.RAG.RANK", "MEMORY.SKILL",
    "INTERACTION.ACT.TOOL", "INTERACTION.ACT.MCP", "CONTEXT.UPDATE",
  ]);
});
