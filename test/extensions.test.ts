import assert from "node:assert/strict";
import test from "node:test";
import { createDitto, defineNode, defineWorker, extendWorker } from "../src/index.js";

declare module "../src/contracts/node-contract-map.js" {
  interface NodeContractMap {
    "MEMORY.ARCHIVE": NodeContract<{ ids: readonly string[] }, { archived: number }>;
    "BROWSER.OPEN": NodeContract<{ url: string }, { title: string }>;
  }
}

test("an experiment extends an existing capability and creates a custom Worker", async () => {
  const ditto = createDitto({ workers: [
    defineWorker({ type: "MEMORY", nodes: {
      "MEMORY.ARCHIVE": defineNode("MEMORY.ARCHIVE", async (input) => ({ archived: input.ids.length })),
    } }),
    extendWorker("BROWSER", { nodes: {
      OPEN: async (input) => ({ title: input.url }),
    } }),
  ] });
  assert.deepEqual(await ditto.invoke("MEMORY.ARCHIVE", { ids: ["1", "2"] }), { archived: 2 });
  assert.deepEqual(await ditto.invoke("BROWSER.OPEN", { url: "fixture://page" }), { title: "fixture://page" });
});
