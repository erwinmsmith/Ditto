import assert from "node:assert/strict";
import test from "node:test";
import {
  contextCompressNode, contextLoadNode, contextSelectNode, contextUpdateNode,
  interactionMcpNode, interactionToolNode,
  memoryGetNode, memoryQueryNode, memorySearchNode, memoryWriteNode, memoryUpdateNode, memoryDeleteNode,
  inferTrajectoryNode,
} from "../src/index.js";

test("scaffolds expose only the agreed semantic leaf identities", () => {
  assert.deepEqual([
    inferTrajectoryNode.type,
    contextLoadNode.type, contextSelectNode.type, contextUpdateNode.type, contextCompressNode.type,
    memoryGetNode.type, memoryQueryNode.type, memorySearchNode.type, memoryWriteNode.type, memoryUpdateNode.type, memoryDeleteNode.type,
    interactionToolNode.type, interactionMcpNode.type,
  ], [
    "INFER.REASONING.TRAJECTORY",
    "CONTEXT.LOAD", "CONTEXT.SELECT", "CONTEXT.UPDATE", "CONTEXT.COMPRESS",
    "MEMORY.GET", "MEMORY.QUERY", "MEMORY.SEARCH", "MEMORY.WRITE", "MEMORY.UPDATE", "MEMORY.DELETE",
    "INTERACTION.ACT.TOOL", "INTERACTION.ACT.MCP",
  ]);
});
