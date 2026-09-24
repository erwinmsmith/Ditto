import { mkdir, writeFile, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import {
  digest,
  request,
  requirements,
  isCode,
  type Request,
  type Mode,
} from "./domain.ts";
export async function createFixture(
  directory: string,
  mode: Mode,
): Promise<Request> {
  await mkdir(directory, { recursive: true });
  let paths: string[], expected: unknown;
  if (isCode(mode)) {
    const quantity = randomInt(2, 8),
      unitCents = randomInt(100, 999),
      other = randomInt(100, 600),
      expectedTotal = quantity * unitCents + other;
    const code =
      mode === "code-generation"
        ? 'export function invoiceTotal(items) {\n  throw new Error("Not implemented");\n}\n'
        : "export function invoiceTotal(items) {\n  let total = 0;\n  for (const item of items) {\n    total += item.unitCents;\n  }\n  return total;\n}\n";
    const tests = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {invoiceTotal} from ${JSON.stringify("./invoice.mjs")};\ntest('line quantities',()=>assert.equal(invoiceTotal([{quantity:${quantity},unitCents:${unitCents}},{quantity:1,unitCents:${other}}]),${expectedTotal}));\ntest('empty invoice',()=>assert.equal(invoiceTotal([]),0));\ntest('negative inputs',()=>{for(const row of [{quantity:-1,unitCents:20},{quantity:1,unitCents:-20}])assert.throws(()=>invoiceTotal([row]),RangeError);});\ntest('fractional inputs',()=>{for(const row of [{quantity:1.5,unitCents:20},{quantity:1,unitCents:2.5}])assert.throws(()=>invoiceTotal([row]),RangeError);});\ntest('unsafe inputs',()=>assert.throws(()=>invoiceTotal([{quantity:Number.MAX_SAFE_INTEGER+1,unitCents:0}]),RangeError));\ntest('unsafe arithmetic',()=>{assert.throws(()=>invoiceTotal([{quantity:2,unitCents:Number.MAX_SAFE_INTEGER}]),RangeError);assert.throws(()=>invoiceTotal([{quantity:1,unitCents:Number.MAX_SAFE_INTEGER},{quantity:1,unitCents:1}]),RangeError);});\ntest('immutable inputs',()=>{const rows=Object.freeze([Object.freeze({quantity:1,unitCents:20})]);assert.equal(invoiceTotal(rows),20);});\n`;
    await writeFile(join(directory, "invoice.mjs"), code);
    await writeFile(join(directory, "invoice.test.mjs"), tests);
    await writeFile(
      join(directory, "README.md"),
      "# Invoice module\n" + requirements["code-generation"] + "\n",
    );
    paths = ["invoice.mjs", "invoice.test.mjs", "README.md"];
    expected = { testCount: 7, expectedTotal, quantity, unitCents, other };
  } else {
    const price = randomInt(101, 901),
      raw = [
        ["a", "2026/09/01", " east ", "2", String(price), " PAID "],
        ["b", "2026-09-02", "North", "3", "200", "paid"],
        ["c", "2026-09-03", "West", "4", "300", "pending"],
        ["d", "2026-09-04", "East", "1", "400", "refunded"],
        ["e", "2026-09-05", "North", "5", "100", "paid"],
        ["f", "2026-09-06", "", "1", "250", "paid"],
        ["a", "2026-09-01", "East", "2", String(price), "paid"],
        ["bad-missing", "2026-09-01", "East", "", "300", "paid"],
        ["bad-negative", "2026-09-01", "East", "1", "-300", "paid"],
        ["bad-date", "2026-02-30", "West", "1", "300", "paid"],
        ["bad-status", "2026-09-01", "West", "1", "300", "unknown"],
        ["bad-range", "2026-09-01", "West", "1001", "300", "paid"],
      ];
    const rows = [
      {
        orderId: "a",
        date: "2026-09-01",
        region: "East",
        quantity: 2,
        unitCents: price,
        status: "paid",
      },
      {
        orderId: "b",
        date: "2026-09-02",
        region: "North",
        quantity: 3,
        unitCents: 200,
        status: "paid",
      },
      {
        orderId: "c",
        date: "2026-09-03",
        region: "West",
        quantity: 4,
        unitCents: 300,
        status: "pending",
      },
      {
        orderId: "d",
        date: "2026-09-04",
        region: "East",
        quantity: 1,
        unitCents: 400,
        status: "refunded",
      },
      {
        orderId: "e",
        date: "2026-09-05",
        region: "North",
        quantity: 5,
        unitCents: 100,
        status: "paid",
      },
      {
        orderId: "f",
        date: "2026-09-06",
        region: "Unknown",
        quantity: 1,
        unitCents: 250,
        status: "paid",
      },
    ];
    await writeFile(
      join(directory, "sales.csv"),
      "orderId,date,region,quantity,unitCents,status\n" +
        raw.map((r) => r.join(",")).join("\n") +
        "\n",
    );
    const db = new DatabaseSync(join(directory, "business.sqlite"));
    try {
      db.exec(
        "CREATE TABLE sales(orderId TEXT PRIMARY KEY,date TEXT,region TEXT,quantity INTEGER,unitCents INTEGER,status TEXT)",
      );
      const insert = db.prepare("INSERT INTO sales VALUES(?,?,?,?,?,?)");
      for (const r of rows)
        insert.run(
          r.orderId,
          r.date,
          r.region,
          r.quantity,
          r.unitCents,
          r.status,
        );
    } finally {
      db.close();
    }
    const total = 2 * price + 600 + 500 + 250;
    expected = {
      rows,
      rawRows: 12,
      removedRows: 6,
      metrics: {
        paidOrders: 4,
        totalRevenueCents: total,
        averageOrderCents: Math.round(total / 4),
        byRegion: [
          { region: "East", revenueCents: 2 * price, orders: 1 },
          { region: "North", revenueCents: 1100, orders: 2 },
          { region: "Unknown", revenueCents: 250, orders: 1 },
        ],
      },
    };
    paths = ["sales.csv", "business.sqlite"];
  }
  const r = request({
    id: randomUUID(),
    tenant: "demo",
    mode,
    instruction:
      mode === "query"
        ? "按地区统计已付款订单的数量和订单总金额，按地区排序，金额用整数分表示。"
        : requirements[mode],
    sources: await Promise.all(
      paths.map(async (path) => ({
        path,
        sha256: digest(await readFile(join(directory, path))),
      })),
    ),
  });
  await writeFile(join(directory, "request.json"), JSON.stringify(r, null, 2));
  await writeFile(
    join(directory, "expected.json"),
    JSON.stringify(expected, null, 2),
  );
  return r;
}
export async function resumeFixture(directory: string): Promise<Request> {
  return request(
    JSON.parse(await readFile(join(directory, "request.json"), "utf8")),
  );
}
