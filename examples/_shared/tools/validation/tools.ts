import { readFile, realpath, stat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import { immutable } from "../execution/files.ts";
import {
  digest,
  json,
  request,
  material,
  assessment,
  policy,
  gate,
  type Request,
  type Policy,
  type Material,
  type Assessment,
  type Receipt,
} from "./domain.ts";
export const toolNames = ["validation_source", "validation_commit"];
export function openValidationTools(directory: string, input: Request) {
  const r = request(input),
    root = resolve(directory),
    db = new DatabaseSync(join(root, "business.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS approvals (binding TEXT PRIMARY KEY, actor TEXT NOT NULL); CREATE TABLE IF NOT EXISTS effects (task TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT NOT NULL);",
  );
  const fingerprint = digest(JSON.stringify(r));
  function current(): Policy {
    const row = db.prepare("SELECT value FROM policy WHERE id=1").get();
    if (!row) throw new Error("Missing trusted policy");
    return policy(JSON.parse(String(row.value)));
  }
  async function source(): Promise<Material> {
    const file = join(root, "source.json");
    const info = await stat(file);
    if ((await realpath(file)) !== file || !info.isFile() || info.size > 32000)
      throw new Error("Unsafe source file");
    const b = await readFile(file);
    if (digest(b) !== r.sourceHash) throw new Error("Source checksum mismatch");
    // Raw bytes stay inside this adapter. They are not returned to Runtime, traces, Redis or Memory.
    let raw: unknown;
    try {
      raw = JSON.parse(b.toString("utf8"));
    } catch {
      throw new Error("Invalid source JSON");
    }
    return material(raw, r.sourceHash);
  }
  const binding = (m: Material, a: Assessment, p: Policy) =>
    digest(
      JSON.stringify({
        fingerprint,
        document: m.document,
        assessment: a,
        policy: p,
      }),
    );
  function same(actual: unknown, expected: unknown) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error("Checked payload changed");
  }
  const tools: RegisteredTool[] = [
    {
      name: "validation_source",
      effects: ["read"],
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      validate(args) {
        if (Object.keys(args).length)
          throw new Error("Source accepts no arguments");
      },
      async execute(_args, ctx) {
        ctx.signal?.throwIfAborted();
        return { status: "success", structuredContent: json(await source()) };
      },
    },
    {
      name: "validation_commit",
      effects: ["read", "write"],
      requiresApproval: true,
      inputSchema: {
        type: "object",
        properties: {
          material: { type: "object" },
          assessment: { type: "object" },
        },
        required: ["material", "assessment"],
        additionalProperties: false,
      },
      validate(args) {
        if (Object.keys(args).sort().join() !== "assessment,material")
          throw new Error("Invalid commit arguments");
      },
      async execute(args, ctx) {
        const m = await source();
        same(args.material, m);
        const a = assessment(args.assessment, m);
        ctx.signal?.throwIfAborted();
        let receipt: Receipt;
        db.exec("BEGIN IMMEDIATE");
        try {
          const previous = db
            .prepare(
              "SELECT fingerprint,payload,receipt FROM effects WHERE task=?",
            )
            .get(r.id);
          if (previous) {
            if (
              previous.fingerprint !== fingerprint ||
              previous.payload !== JSON.stringify(m.document)
            )
              throw new Error("Idempotency conflict");
            receipt = JSON.parse(String(previous.receipt)) as Receipt;
          } else {
            const p = current(),
              approved = !!db
                .prepare("SELECT actor FROM approvals WHERE binding=?")
                .get(binding(m, a, p));
            const decision = gate(r, m, a, p, approved);
            receipt = {
              ...decision,
              payloadHash: digest(JSON.stringify(m.document)),
              effectId:
                decision.status === "published"
                  ? digest(fingerprint + ":publish")
                  : null,
            };
            if (receipt.status === "published")
              db.prepare("INSERT INTO effects VALUES(?,?,?,?)").run(
                r.id,
                fingerprint,
                JSON.stringify(m.document),
                JSON.stringify(receipt),
              );
          }
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        // A report-write failure can be retried: the durable effect is acknowledged without publishing twice.
        const report = {
          taskId: r.id,
          mode: r.mode,
          material: m,
          assessment: a,
          receipt,
        };
        const content = JSON.stringify(report, null, 2) + "\n",
          name = digest(content) + ".json";
        await mkdir(join(root, "output"), { recursive: true });
        await immutable(join(root, "output", name), content);
        return {
          status: "success",
          structuredContent: json({
            ...report,
            file: "output/" + name,
            sha256: digest(content),
          }),
        };
      },
    },
  ];
  return {
    tools,
    // These controller methods are never registered as agent tools. Authentication is the host's responsibility.
    setPolicy(value: Policy) {
      const p = policy(value);
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare("SELECT value FROM policy WHERE id=1").get();
        if (row && p.revision <= policy(JSON.parse(String(row.value))).revision)
          throw new Error("Policy revision must increase");
        db.prepare(
          "INSERT INTO policy VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        ).run(JSON.stringify(p));
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    current,
    async approve(a: Assessment, actor: string) {
      if (actor !== "trusted-reviewer")
        throw new Error("Reviewer not authorized");
      const m = await source();
      assessment(a, m);
      const p = current();
      db.prepare("INSERT OR REPLACE INTO approvals VALUES(?,?)").run(
        binding(m, a, p),
        actor,
      );
    },
    countEffects() {
      return Number(
        db.prepare("SELECT count(*) AS count FROM effects").get()!.count,
      );
    },
    close() {
      db.close();
    },
  };
}
