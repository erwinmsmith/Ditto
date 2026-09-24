import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { event, type Event, type Release } from "../../_shared/tools/lifecycle-store.ts";
export type Mode = "tracking" | "state" | "stop" | "scheduled" | "event";
export async function createFixture(directory: string, mode: Mode): Promise<Release> {
  const source: Release = { id: `REL-${randomBytes(4).toString("hex")}`, revision: 1, status: mode === "state" ? "draft" : "ready", title: "Release notice", change: `Enable export marker ${randomBytes(6).toString("hex")}.` };
  await writeFile(join(directory, "task.source.json"), JSON.stringify(source, null, 2));
  await writeFile(join(directory, "application.json"), JSON.stringify({ mode })); return source;
}
/** Producers publish a complete event with atomic rename into the application's trusted inbox. */
export async function emitEvent(directory: string, value: Event): Promise<void> {
  value = event(value);
  const inbox = join(directory, "inbox"); await mkdir(inbox, { recursive: true });
  const temporary = join(inbox, `${value.taskId}.${randomBytes(8).toString("hex")}.tmp`);
  await writeFile(temporary, JSON.stringify(value)); await rename(temporary, join(inbox, `${value.taskId}.json`));
}
