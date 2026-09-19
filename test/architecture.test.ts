import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { INFER_CACHE_NAMESPACE } from "../src/index.js";

const root = process.cwd();
const leaves = [
  "infer/reasoning/trajectory/node", "infer/reasoning/reflect/node", "infer/reasoning/deliberate/node", "infer/reasoning/sample/node",
  "infer/cache/lookup/node", "infer/cache/write/node", "infer/cache/invalidate/node",
  "context/load", "context/select", "context/update", "context/compress", "context/rag/embed", "context/rag/retrieve", "context/rag/rank", "context/skill",
  "memory/retrieve", "memory/write", "memory/update", "memory/consolidate", "memory/evict", "memory/rag/embed", "memory/rag/retrieve", "memory/rag/rank", "memory/skill",
  "interaction/act/tool/node", "interaction/act/mcp", "interaction/observe", "interaction/output",
] as const;

test("every agreed leaf Node has a module in the existing worker tree", async () => {
  await Promise.all(leaves.map((leaf) => access(join(root, "src", "worker", `${leaf}.ts`))));
  assert.equal(leaves.length, 28);
  await assert.rejects(access(join(root, "src", "workers")), { code: "ENOENT" });
  assert.equal(INFER_CACHE_NAMESPACE, "INFER.CACHE");
  await access(join(root, "src", "worker", "infer", "cache", "index.ts"));
  await access(join(root, "src", "worker", "infer", "providers", "index.ts"));
  await access(join(root, "src", "worker", "interaction", "act", "tool", "linux-commands", "index.ts"));
});

test("the bilingual contract documents describe the final taxonomy", async () => {
  for (const name of ["13-node-api-contract.md", "13-node-api-contract.zh-CN.md"]) {
    const document = await readFile(join(root, "docs", name), "utf8");
    for (const node of ["INFER.REASONING.TRAJECTORY", "CONTEXT.RAG.RANK", "MEMORY.SKILL", "INTERACTION.ACT.MCP"]) {
      assert.match(document, new RegExp(node.replaceAll(".", "\\.")));
    }
    assert.doesNotMatch(document, /CONTEXT\.RAG\.PACK/);
    assert.doesNotMatch(document, /INTERACTION\.COMMUNICATE/);
  }
});
