import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BriefSpec } from "../../_shared/tools/brief-files.ts";
export type Mode = "bounded" | "adaptive" | "improvement" | "retrieval" | "goal" | "stop";
/** Concrete task inputs; randomized values make acceptance independent of memorized answers. */
export async function createFixture(directory: string, mode: Mode) {
  await mkdir(directory, { recursive: true });
  const expected = { code: `REL-${randomBytes(4).toString("hex")}`, owner: `team-${randomBytes(3).toString("hex")}`, deadline: `2026-12-${10 + Number.parseInt(randomBytes(1).toString("hex"), 16) % 18}` };
  const required = Object.keys(expected), catalog = required.map(field => ({ id: `${field}-source`, fields: [field] }));
  for (const [field, value] of Object.entries(expected)) await writeFile(join(directory, `${field}-source.json`), JSON.stringify({ facts: { [field]: value } }, null, 2));
  const searching = mode === "adaptive" || mode === "retrieval";
  if (mode === "adaptive") catalog.unshift({ id: "stale-source", fields: ["code"] });
  const spec: BriefSpec = { required, catalog, initialEvidence: searching ? [] : catalog.map(source => source.id),
    initialDraft: mode === "improvement" ? { code: "obsolete-code", owner: "previous-owner", deadline: "expired" } : mode === "goal" ? { ...expected, deadline: "expired" } : {} };
  await writeFile(join(directory, "spec.json"), JSON.stringify(spec, null, 2));
  return { expected, spec };
}
