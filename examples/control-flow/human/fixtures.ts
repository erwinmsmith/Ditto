import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Brief, HumanMode, ReviewerPolicy } from "../../_shared/tools/human-review-store.ts";
/** Trusted example application policy; actor identity is supplied by its authenticated controller. */
export const reviewers: ReviewerPolicy = {
  "example-operator": ["activate"], "example-editor": ["intermediate", "edit"], "example-publisher": ["publish"], "example-triager": ["handoff"],
};
export async function createFixture(directory: string, mode: HumanMode) {
  const code = randomBytes(4).toString("hex");
  const source: Brief = { releaseId: `REL-${code}`, title: `Release ${code}`, change: `Add export marker ${randomBytes(4).toString("hex")}.`,
    sources: [{ id: "release-plan", date: "2026-12-10" }, { id: "release-ticket", date: mode === "escalation" ? "2026-12-14" : "2026-12-10" }] };
  await writeFile(join(directory, "task.source.json"), JSON.stringify(source, null, 2));
  await writeFile(join(directory, "task.deployment.json"), JSON.stringify({ releaseId: source.releaseId, active: false }, null, 2));
  await writeFile(join(directory, "application.json"), JSON.stringify({ mode, reviewers }, null, 2));
  return source;
}
