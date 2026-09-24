import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDitto, graph } from "@ditto/core/runtime";
import {
  createContextWorker,
  createInMemoryContextStore,
} from "@ditto/core/worker/context";
import { createMemoryWorker } from "@ditto/core/worker/memory";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { createRetrievalWorker } from "@ditto/core/worker/retrieval";
import { openSqliteMemory } from "../examples/_shared/tools/storage/sqlite-memory.ts";
import { RagAdapters } from "../examples/_shared/tools/rag/adapters.ts";
import {
  answer,
  chunks,
  plan,
  request,
  selection,
  sources,
  tokens,
  verify,
  type Chunk,
  type Request,
  type Report,
  type Source,
} from "../examples/_shared/tools/rag/domain.ts";
import { runRag, action } from "../examples/patterns/rag-qa/index.ts";
const source: Source = {
  id: "policy",
  tenant: "demo",
  readers: ["alice"],
  title: "设备借用制度",
  kind: "document",
  ref: "policy.md",
};
const raw =
  "# 设备借用\n\n借用设备必须登记设备编号，超过七天需要重新确认归还日期。\n";
const input: Request = {
  id: "task",
  tenant: "demo",
  principal: "alice",
  question: "设备借用有什么要求？",
  sourceIds: ["policy"],
};
async function setup(invalidDrafts = 0) {
  const dir = await mkdtemp(join(tmpdir(), "ditto-rag-unit-"));
  await writeFile(join(dir, "sources.json"), JSON.stringify([source]));
  await writeFile(join(dir, "policy.md"), raw);
  const adapters = new RagAdapters(dir, input),
    memory = openSqliteMemory(join(dir, "memory.sqlite"));
  let calls = 0;
  const runtime = createDitto({
    sandbox: { tools: adapters.tools.map((t) => t.name) },
    workers: [
      createContextWorker({
        services: { stateStore: createInMemoryContextStore() },
      }),
      createMemoryWorker({ store: memory.store }),
      createRetrievalWorker({ providers: adapters.providers }),
      createInteractionWorker({ tools: adapters.tools }),
      createInferWorker({
        providers: {
          unit: {
            async invoke(i) {
              calls++;
              const prompt = String(i.messages[0]!.content),
                items = JSON.parse(String(i.messages[1]!.content)),
                value = items.find(
                  (x: { id: string }) => x.id === "working-set",
                ).content;
              let result: unknown;
              if (prompt.includes("Understand the question"))
                result = {
                  intent: "设备借用要求",
                  queries: ["设备借用"],
                  facets: ["要求"],
                  clarification: null,
                };
              else if (prompt.includes("Select relevant chunks"))
                result = {
                  selectedIds: value.pool
                    .filter((c: Chunk) => c.text.includes("七天"))
                    .map((c: Chunk) => c.id),
                  missing: [],
                  conflicts: [],
                };
              else if (prompt.includes("Generate a useful"))
                result = {
                  status: "answered",
                  claims: [
                    {
                      text: "设备借用要登记编号，超过七天需要重新确认归还日期。",
                      citations: [
                        {
                          chunkId: value.evidence[0].id,
                          quote: value.evidence[0].text,
                        },
                      ],
                    },
                  ],
                  limitations: [],
                };
              else
                result = {
                  complete: true,
                  claims: [{ index: 0, supported: true }],
                };
              if (prompt.includes("Generate a useful") && invalidDrafts > 0) {
                invalidDrafts--;
                (
                  result as { claims: { citations: { quote: string }[] }[] }
                ).claims[0]!.citations[0]!.quote = "FABRICATED_QUOTE";
              }
              return {
                message: { role: "assistant", content: JSON.stringify(result) },
                finishReason: "stop",
              };
            },
          },
        },
      }),
    ],
  });
  return {
    dir,
    runtime,
    adapters,
    calls: () => calls,
    run: () =>
      runRag(runtime, {
        request: input,
        model: { provider: "unit", model: "unit" },
      }),
    async close() {
      await runtime.close();
      await memory.close();
      adapters.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("RAG composes real local FTS, Memory and artifacts through Runtime with explicit unit model/Context", async () => {
  const s = await setup();
  try {
    const result = (await s.run()) as Report;
    assert.equal(result.answer.status, "answered");
    assert.equal(s.calls(), 4);
    assert.deepEqual(
      JSON.parse(await readFile(join(s.dir, "artifacts/answer.json"), "utf8")),
      result,
    );
    assert.deepEqual(await s.run(), result);
    assert.equal(s.calls(), 4);
    await assert.rejects(
      runRag(s.runtime, {
        request: { ...input, question: "changed" },
        model: { provider: "unit", model: "unit" },
      }),
      /Request changed/,
    );
  } finally {
    await s.close();
  }
});
test("RAG CJK tokenization, chunk offsets and hashes preserve exact source evidence", () => {
  assert.ok(tokens("设备借用 Atlas").includes("借用"));
  assert.ok(tokens("设备借用 Atlas").includes("atlas"));
  const values = chunks(source, raw);
  assert.equal(values[1]!.startLine, 3);
  assert.equal(values[1]!.text, raw.split("\n")[2]);
  assert.notEqual(
    chunks(source, raw + "changed")[0]!.snapshot,
    values[0]!.snapshot,
  );
  assert.throws(() => chunks(source, "x".repeat(1601)));
});
test("RAG rejects invented citations, unsupported statuses and incomplete grounding checks", () => {
  const evidence = chunks(source, raw).slice(1),
    c = evidence[0]!,
    selected = { selectedIds: [c.id], missing: [], conflicts: [] };
  const valid = {
    status: "answered",
    claims: [
      { text: "Seven days", citations: [{ chunkId: c.id, quote: c.text }] },
    ],
    limitations: [],
  };
  assert.equal(answer(valid, evidence, selected).claims.length, 1);
  assert.throws(() =>
    answer(
      {
        ...valid,
        claims: [
          { text: "fake", citations: [{ chunkId: c.id, quote: "invented" }] },
        ],
      },
      evidence,
      selected,
    ),
  );
  assert.throws(() =>
    answer(valid, evidence, { ...selected, missing: ["price"] }),
  );
  for (const v of [
    { complete: true, claims: [] },
    { complete: true, claims: [{ index: 0, supported: false }] },
    {
      complete: true,
      claims: [
        { index: 0, supported: true },
        { index: 0, supported: true },
      ],
    },
  ])
    assert.throws(() => verify(v, 1));
});
test("RAG conflict output must cite both sides; selection cannot invent evidence", () => {
  const a = chunks(source, raw)[1]!,
    b = chunks({ ...source, id: "other" }, "借用超过五天需要重新确认。")[0]!,
    pool = [a, b],
    s = {
      selectedIds: [a.id, b.id],
      missing: [],
      conflicts: [
        { sourceIds: [a.id, b.id], description: "five versus seven" },
      ],
    };
  assert.deepEqual(selection(s, pool), s);
  assert.throws(() => selection({ ...s, selectedIds: [a.id] }, pool));
  assert.throws(() =>
    answer(
      {
        status: "conflicting-evidence",
        claims: [
          { text: "seven", citations: [{ chunkId: a.id, quote: a.text }] },
        ],
        limitations: ["resolve policy"],
      },
      pool,
      s,
    ),
  );
});
test("RAG request boundaries reject paths, cross-tenant Memory keys and duplicate IDs", () => {
  assert.throws(() => request({ ...input, id: "../task" }));
  assert.throws(() => request({ ...input, sourceIds: ["policy", "policy"] }));
  assert.throws(() => sources([{ ...source, ref: "../secret.md" }]));
  assert.throws(() =>
    sources([{ ...source, kind: "internal", ref: "knowledge:other:secret" }]),
  );
  assert.throws(() => sources([source, source]));
  assert.throws(() =>
    plan({ intent: "find", queries: [], facets: [], clarification: null }),
  );
});
test("RAG checks ACL before model execution and after a completed checkpoint", async () => {
  const s = await setup();
  try {
    await assert.rejects(
      runRag(s.runtime, {
        request: { ...input, principal: "bob" },
        model: { provider: "unit", model: "unit" },
      }),
    );
    assert.equal(s.calls(), 0);
    await writeFile(
      join(s.dir, "sources.json"),
      JSON.stringify([{ ...source, readers: [] }]),
    );
    await assert.rejects(s.run());
    assert.equal(s.calls(), 0);
    await writeFile(join(s.dir, "sources.json"), JSON.stringify([source]));
    await s.run();
    await writeFile(
      join(s.dir, "sources.json"),
      JSON.stringify([{ ...source, readers: [] }]),
    );
    await assert.rejects(s.run());
    assert.equal(s.calls(), 4);
  } finally {
    await s.close();
  }
});
test("RAG detects snapshot tampering, denies foreign retrieval namespaces and escaping symlinks", async () => {
  const s = await setup(),
    outside = await mkdtemp(join(tmpdir(), "ditto-rag-outside-"));
  try {
    await action(s.runtime, "rag_ingest", { memories: {} });
    const query = graph("test-rag-namespace").node(
      "result",
      "RETRIEVAL.SEARCH",
      [],
      () => ({
        target: { name: "rag-corpus", namespace: "other" },
        query: { content: "设备" },
      }),
    );
    assert.equal((await s.runtime.run(query, {})).result.status, "failed");
    const evidence = chunks(source, raw);
    await writeFile(
      join(s.dir, "snapshots", `${evidence[0]!.snapshot}.txt`),
      "tampered",
    );
    await assert.rejects(action(s.runtime, "rag_check_sources", { evidence }));
    await writeFile(join(outside, "secret.md"), "Secret data");
    await rm(join(s.dir, "policy.md"));
    await symlink(join(outside, "secret.md"), join(s.dir, "policy.md"));
    await assert.rejects(action(s.runtime, "rag_ingest", { memories: {} }));
  } finally {
    await s.close();
    await rm(outside, { recursive: true, force: true });
  }
});

test("RAG repairs one rejected draft and never publishes after the second rejection", async () => {
  for (const count of [1, 2]) {
    const s = await setup(count);
    try {
      if (count === 1) {
        const result = (await s.run()) as Report;
        assert.equal(result.answer.status, "answered");
        assert.equal(s.calls(), 5);
        assert.ok(
          result.trace.some(
            (t) =>
              t.stage === "answer-validation" &&
              t.detail.startsWith("2 draft attempts"),
          ),
        );
      } else {
        await assert.rejects(s.run(), /Unsupported citation/);
        assert.equal(s.calls(), 4);
        assert.equal(
          await readFile(join(s.dir, "artifacts/answer.json")).then(
            () => true,
            () => false,
          ),
          false,
        );
      }
    } finally {
      await s.close();
    }
  }
});
