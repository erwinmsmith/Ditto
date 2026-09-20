import assert from "node:assert/strict";
import test from "node:test";
import {
  contextRagEmbedNode, contextRagRankNode, contextRagRetrieveNode,
  contextSkillNode, contextUpdateNode, interactionMcpNode, interactionToolNode,
  memoryGetNode, memoryQueryNode, memorySearchNode, memoryWriteNode, memoryUpdateNode, memoryDeleteNode,
  inferTrajectoryNode,
} from "../src/index.js";

test("scaffolds expose semantic identity without embedding implementations", () => {
  assert.deepEqual([
    inferTrajectoryNode.type,
    contextRagEmbedNode.type, contextRagRetrieveNode.type, contextRagRankNode.type, contextSkillNode.type,
    memoryGetNode.type, memoryQueryNode.type, memorySearchNode.type, memoryWriteNode.type, memoryUpdateNode.type, memoryDeleteNode.type,
    interactionToolNode.type, interactionMcpNode.type, contextUpdateNode.type,
  ], [
    "INFER.REASONING.TRAJECTORY",
    "CONTEXT.RAG.EMBED", "CONTEXT.RAG.RETRIEVE", "CONTEXT.RAG.RANK", "CONTEXT.SKILL",
    "MEMORY.GET", "MEMORY.QUERY", "MEMORY.SEARCH", "MEMORY.WRITE", "MEMORY.UPDATE", "MEMORY.DELETE",
    "INTERACTION.ACT.TOOL", "INTERACTION.ACT.MCP", "CONTEXT.UPDATE",
  ]);
});
