import assert from "node:assert/strict";
import test from "node:test";
import {
  auditCapabilities,
  auditCapabilitySource,
} from "../scripts/lib/capability-boundary.ts";
test("all twelve capability categories compose public nodes through Runtime", async () => {
  const audit = await auditCapabilities(process.cwd());
  assert.equal(audit.categories.length, 12);
  assert.equal(audit.examples, 86);
  for (const row of audit.matrix)
    assert.ok(row.nodes.includes("INTERACTION.ACT.TOOL"));
});
test("capability boundary rejects private modules, computed executors and model transport bypass", () => {
  const file = "/app/examples/capabilities/example/shared.ts",
    entries = ["@codesoul-co/ditto/runtime"];
  for (const source of [
    'import {graph} from "../../src/runtime/index.ts";',
    'await worker["execute"](node,input,context);',
    "definition[`instantiate`]();",
    'await fetch("https://model.example/");',
    "const api=createInferApi();",
    'readFile("../node_modules/@codesoul-co/ditto/dist/index.js");',
    'await runtime.run(g, input);',
  ])
    assert.throws(() => auditCapabilitySource(source, file, entries));
  assert.deepEqual(
    auditCapabilitySource(
      'import {graph} from "@codesoul-co/ditto/runtime"; yield* graphStep(g,input);',
      file,
      entries,
    ),
    entries,
  );
});

test("capability release selection preserves full suites by default and keeps every mode", async () => {
  const { limitCapabilityCases } =
    await import("../scripts/lib/capability-cases.ts");
  const cases = [
    { mode: "goal", name: "goal-task" },
    { mode: "goal", name: "fault" },
    { mode: "choices", name: "real-choice" },
  ];
  const full = [...cases];
  limitCapabilityCases(full, "complete");
  assert.deepEqual(full, cases);
  const selected = [...cases];
  limitCapabilityCases(selected, "capabilities");
  assert.deepEqual(selected, [cases[0], cases[2]]);
  assert.throws(() => limitCapabilityCases([...cases], "unknown"));
});
