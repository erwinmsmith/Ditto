import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { PickupTaskStore } from "../examples/_shared/tools/pickup-task-store.ts";
import { createFileTools } from "../examples/_shared/tools/file-ingestion/index.ts";
import { resumeRisk } from "../examples/control-flow/routing/risk.ts";
import { runFileTask } from "../examples/control-flow/routing/file-type.ts";

const value = { code: "PICKUP-731", quantity: 3 };
test("durable approval binds a stored pending payload; restart and retries preserve exactly one pickup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-task-test-"));
  const store = new PickupTaskStore(directory);
  const runtime = createDitto({ sandbox: { tools: ["record_pickup"] }, workers: [createInteractionWorker({ tools: [store.tool], output: store.output })] });
  const call = { id: "approval", name: "record_pickup", arguments: { id: "approval", ...value } };
  try {
    store.create("approval", "risk", 60);
    await assert.rejects(runtime.invoke("INTERACTION.ACT.TOOL", { call }), /not authorized/);
    await runtime.invoke("INTERACTION.OUTPUT", { deliveryId: "approval", message: { role: "assistant", content: { route: "confirm", status: "pending_confirmation", ...value } } });
    await store.review("approval", "approve", "test-reviewer");
    assert.equal(store.authorized("approval", { ...value, quantity: 4 }), false);
    await assert.rejects(resumeRisk(runtime, { id: "approval", value: { ...value, quantity: 4 }, route: "confirm", authorize: () => true }), /not authorized/);
    for (let index = 0; index < 2; index++) await resumeRisk(runtime, { id: "approval", value, route: "confirm", authorize: (id, value) => store.authorized(id, value) });
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM pickups").get()?.count, 1);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "deliveries/approval.json"), "utf8")), {
      taskId: "approval", status: "completed", content: { route: "confirm", status: "executed", ...value },
    });
    await runtime.close();
    store.close();
    const reopened = new PickupTaskStore(directory);
    try {
      assert.equal(reopened.task("approval").status, "completed");
      assert.deepEqual({ ...reopened.pickup("approval") }, value);
      assert.equal(reopened.authorized("approval", value), true);
    } finally { reopened.close(); }
  } finally { await runtime.close(); if (store.db.isOpen) store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("rejected and failed tasks persist their terminal status without business writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-task-test-"));
  const store = new PickupTaskStore(directory);
  const runtime = createDitto({ sandbox: { tools: ["record_pickup"] }, workers: [createInteractionWorker({ tools: [store.tool], output: store.output })] });
  try {
    store.create("rejected", "risk", 60);
    await runtime.invoke("INTERACTION.OUTPUT", { deliveryId: "rejected", message: { role: "assistant", content: { route: "confirm", status: "pending_confirmation", ...value } } });
    await store.review("rejected", "reject", "test-reviewer");
    await assert.rejects(resumeRisk(runtime, { id: "rejected", value, route: "confirm", authorize: () => true }), /not authorized/);
    assert.equal(store.task("rejected").status, "rejected");
    assert.equal(JSON.parse(await readFile(join(directory, "deliveries/rejected.json"), "utf8")).status, "rejected");
    assert.equal(store.pickup("rejected"), undefined);
    store.create("failed", "file");
    await store.fail("failed", "FILE_PARSE_FAILED");
    assert.equal(store.task("failed").status, "failed");
    assert.equal(JSON.parse(await readFile(join(directory, "deliveries/failed.json"), "utf8")).content.error, "FILE_PARSE_FAILED");
    assert.throws(() => store.create("../escape", "file"), /Invalid task id/);
  } finally { await runtime.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("file task rejects MIME mismatch and malformed parser output before inference or delivery", async () => {
  let toolCalls = 0;
  let modelCalls = 0;
  let deliveries = 0;
  const runtime = createDitto({ sandbox: { tools: ["decode_pdf"] }, workers: [
    createInferWorker({ providers: { unit: { async invoke() { modelCalls++; throw new Error("Unexpected inference"); } } } }),
    createInteractionWorker({ tools: [{ name: "decode_pdf", inputSchema: {}, validate() {}, async execute() {
      toolCalls++; return { status: "success", structuredContent: { name: "wrong.pdf", mediaType: "application/pdf", text: "unexpected" } };
    } }], output: { async deliver(input) { deliveries++; return { deliveryId: input.deliveryId, status: "accepted" }; } } }),
  ] });
  try {
    const input = { id: "file", model: { provider: "unit", model: "unit" }, file: { path: "input.pdf", name: "input.pdf", mediaType: "image/png" } };
    await assert.rejects(runFileTask(runtime, input), /mismatched/);
    assert.equal(toolCalls, 0);
    await assert.rejects(runFileTask(runtime, { ...input, file: { ...input.file, mediaType: "application/pdf" } }), /does not match/);
    assert.equal(toolCalls, 1);
    assert.equal(modelCalls, 0);
    assert.equal(deliveries, 0);
  } finally { await runtime.close(); }
});

test("file tool rejects files outside its configured root before executing a subprocess", async () => {
  const root = await mkdtemp(join(tmpdir(), "ditto-file-root-"));
  const outside = await mkdtemp(join(tmpdir(), "ditto-file-outside-"));
  const path = join(outside, "input.pdf");
  await writeFile(path, "%PDF-1.7");
  const runtime = createDitto({ sandbox: { tools: ["decode_pdf"] }, workers: [createInteractionWorker({ tools: createFileTools({ root, python: "not-an-executable" }) })] });
  try {
    await assert.rejects(runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "parse", name: "decode_pdf", arguments: { path, mediaType: "application/pdf" } } }), /outside the ingestion directory/);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
