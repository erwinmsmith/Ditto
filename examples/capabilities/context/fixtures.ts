import { createServer } from "node:http";
import { randomInt, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Mode, Request } from "../../_shared/tools/context/domain.ts";
export async function serveFixture(directory: string, port = 0) {
  const server = createServer(async (req, res) => {
    try { const data = JSON.parse(await readFile(join(directory, "search.json"), "utf8")), url = new URL(req.url!, "http://localhost"); if (url.pathname !== "/search" || url.searchParams.get("q") !== data.releaseCode) { res.writeHead(404).end(); return; } res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); }
    catch { res.writeHead(503).end(); }
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return { url: `http://127.0.0.1:${address.port}/search`, close: () => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())) };
}
export async function createFixture(directory: string, mode: Mode) {
  const initial = { releaseCode: `REL-${randomInt(10000, 99999)}`, region: "eu-west", rolloutPercent: randomInt(5, 40) };
  const revised = { ...initial, region: "ap-south", rolloutPercent: initial.rolloutPercent + 40 };
  const decisions = { owner: `Owner-${randomInt(100, 999)}`, budget: randomInt(30, 80) * 100 };
  const turns = [{ text: `Approved release owner: ${decisions.owner}.` }, { text: `Approved release budget: ${decisions.budget} USD.` }, ...Array.from({ length: 18 }, (_, i) => ({ text: `Incidental discussion ${i}: ` + "The cafeteria furniture and office plants were discussed without any deployment decisions. ".repeat(8) }))];
  await writeFile(join(directory, "document.json"), JSON.stringify(initial)); await writeFile(join(directory, "revision.json"), JSON.stringify(revised));
  await writeFile(join(directory, "search.json"), JSON.stringify({ releaseCode: initial.releaseCode, region: "us-east" }));
  const server = await serveFixture(directory);
  const r: Request = { id: randomUUID(), tenant: "team-a", mode, goal: "Prepare the approved release handover with deployment region, rollout percentage, accountable owner and budget.", searchUrl: server.url };
  await writeFile(join(directory, "request.json"), JSON.stringify(r));
  return { request: r, turns, initial, revised, decisions, server };
}
