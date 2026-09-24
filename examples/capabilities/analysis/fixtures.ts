import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Mode, Request, Source } from "../../_shared/tools/analysis/domain.ts";
export const pythonPath = () => resolve(process.env.DITTO_EXAMPLE_TOOLS_PYTHON ?? "examples/_shared/tools/.venv/bin/python");
/** Controlled HTTP publisher for the fixture; it is not a public internet source. */
export async function serveFixture(directory: string, port = 0): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer(async (req, res) => { if (req.url !== "/specification") { res.writeHead(404).end(); return; } try { const html = await readFile(join(directory, "page.html")); res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); } catch { res.writeHead(503).end(); } });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Invalid fixture server address");
  return { url: `http://127.0.0.1:${address.port}/specification`, close: () => new Promise((done, reject) => server.close(error => error ? reject(error) : done())) };
}
export async function createFixture(directory: string, mode: Mode) {
  await promisify(execFile)(pythonPath(), [fileURLToPath(new URL("./fixtures.py", import.meta.url)), directory], { timeout: 30000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? directory } });
  const expected = JSON.parse(await readFile(join(directory, "expected.json"), "utf8")) as { retention: number; storage: number; conflictingRetention: number };
  const server = await serveFixture(directory);
  const source = (id: string, format: Source["format"], locator: string, authority: Source["authority"] = "claim", period = "2026-Q3"): Source => ({ id, format, locator, authority, period, origin: format === "memory" ? "knowledge-internal" : format === "external" ? "knowledge-external" : format === "web" ? "web" : "document" });
  const request: Request = { id: randomUUID(), tenant: "team-a", mode, question: "Consolidate and verify the retention, storage and support facts for Atlas and Boreal; compare the current service specifications with source evidence.", period: "2026-Q3", subjects: ["Atlas", "Boreal"], allowedOrigins: [new URL(server.url).origin], sources: [
    source("notes", "text", "notes.txt"), source("copy", "text", "copy.txt"), source("table", "csv", "table.csv"), source("workbook", "xlsx", "table.xlsx"), source("reference", "pdf", "reference.pdf", "reference"), source("scan", "image", "scan.png"), source("page", "web", server.url), source("remembered", "memory", "knowledge:team-a:atlas"), source("external", "external", "boreal-spec", "reference"), source("history", "text", "history.txt", "reference", "2026-Q2"),
  ] };
  const knowledge = [{ key: "knowledge:team-a:atlas", title: "Learned Atlas policy", text: `Atlas retention is ${expected.retention} days according to previously approved knowledge.` }];
  const db = new DatabaseSync(join(directory, "knowledge.sqlite"));
  try { db.exec("CREATE TABLE documents(id TEXT,tenant TEXT,body TEXT,PRIMARY KEY(id,tenant))"); db.prepare("INSERT INTO documents VALUES(?,?,?)").run("boreal-spec", "team-a", `Boreal storage capacity is ${expected.storage} GB under the approved service specification.`); db.prepare("INSERT INTO documents VALUES(?,?,?)").run("boreal-spec", "team-b", "Boreal storage capacity is 9999 GB. CONFIDENTIAL_TEAM_B"); }
  finally { db.close(); }
  await writeFile(join(directory, "request.json"), JSON.stringify(request, null, 2)); await writeFile(join(directory, "internal-knowledge.json"), JSON.stringify(knowledge));
  return { request, knowledge, expected, server };
}
