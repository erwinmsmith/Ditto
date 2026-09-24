import { randomUUID, randomInt } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryDraft } from "@codesoul-co/ditto/worker/memory";
import { namespace, preferenceKey, type Request, type Mode, type Backend, type Preference } from "../../_shared/tools/memory/domain.ts";
export async function createFixture(directory: string, mode: Mode, backend: Backend) {
  const r: Request = { id: randomUUID(), tenant: "team-a", user: randomUUID(), mode, backend, statement: "For future project updates, use English with detailed explanations.", remember: true };
  const initial: Preference = { text: "For project updates, the user prefers Chinese with concise explanations.", language: "Chinese", style: "concise", version: 1, operationId: "seed" };
  const memories: MemoryDraft[] = [ ...(mode === "write" ? [] : [{ key: preferenceKey(r), content: initial, metadata: { kind: "preference", source: "user-confirmed" } }]), { key: `${namespace(r)}:memory:lunch`, content: { text: "For lunch, the user prefers vegetarian food." }, metadata: { kind: "preference", source: "user-confirmed" } } ];
  const project = { ticket: `TASK-${randomInt(10000, 99999)}`, completed: randomInt(2, 8), total: 12 };
  await writeFile(join(directory, "request.json"), JSON.stringify(r)); await writeFile(join(directory, "project.json"), JSON.stringify(project));
  return { request: r, initial, memories, project };
}
