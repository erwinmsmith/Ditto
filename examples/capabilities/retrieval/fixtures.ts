import { randomUUID, randomInt } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { type Mode, type Request } from "../../_shared/tools/retrieval/domain.ts";
export async function createFixture(directory: string, mode: Mode, change: Partial<Request> = {}) {
  const retentionDays = randomInt(21, 90), backupHours = randomInt(2, 12);
  const request: Request = { id: randomUUID(), tenant: "team-a", mode, knowledge: "external", internalKnowledgeKeys: ["knowledge:team-a:retention", "knowledge:team-a:backup"],
    question: mode === "expand" ? "How do we retain reports and protect backup copies?" : mode === "rewrite" ? "How long do we keep exported reports?" : "Find source evidence about SQLite report retention.",
    query: ["web-search", "web-read"].includes(mode) ? "SQLite" : mode === "rewrite" ? "How long do we keep exported reports?" : "retention",
    vocabulary: ["retention", "backup"], documents: ["policy.md"], urls: ["https://www.sqlite.org/fts5.html"],
    allowedOrigins: ["https://en.wikipedia.org", "https://www.sqlite.org"], searchEngine: "wikipedia", allowPartial: false, ...change };
  // Multi-source uses the common public topic; local records still carry unpredictable task facts.
  if (mode === "multi-source" && change.query === undefined) request.query = "SQLite";
  await writeFile(join(directory, "request.json"), JSON.stringify(request, null, 2));
  await writeFile(join(directory, "policy.md"), `# SQLite reports policy\n\nSQLite report retention is ${retentionDays} days for team-a; expired exports must be removed.\n\nSQLite backup copies are produced every ${backupHours} hours and stored separately.\n`);
  const db = new DatabaseSync(join(directory, "knowledge.sqlite"));
  try { db.exec("CREATE VIRTUAL TABLE articles USING fts5(tenant UNINDEXED, title, body)");
    const insert = db.prepare("INSERT INTO articles(tenant,title,body) VALUES(?,?,?)");
    insert.run("team-a", "SQLite retention policy", `SQLite report retention is ${retentionDays} days; the team-a owner reviews deletion records weekly.`);
    insert.run("team-a", "SQLite backup policy", `SQLite backup copies are produced every ${backupHours} hours; restoration is checked monthly.`);
    insert.run("team-b", "Restricted SQLite retention", "SQLite retention is 999 days. CONFIDENTIAL_TEAM_B must never enter team-a results.");
  } finally { db.close(); }
  const internalKnowledge = [
    { key: "knowledge:team-a:retention", title: "Learned retention policy", text: `SQLite report retention is ${retentionDays} days, according to the approved policy saved in Agent Memory.` },
    { key: "knowledge:team-a:backup", title: "Learned backup policy", text: `SQLite backup copies are produced every ${backupHours} hours, according to approved Agent knowledge.` },
  ];
  await writeFile(join(directory, "internal-knowledge.json"), JSON.stringify(internalKnowledge, null, 2));
  return { request, retentionDays, backupHours, internalKnowledge };
}
