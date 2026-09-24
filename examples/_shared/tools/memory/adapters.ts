import { readFile, lstat, mkdir, writeFile, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import { json, object, project } from "./domain.ts";
export function memoryTools(directory: string, namespace: string): RegisteredTool[] {
  return [
    { name: "memory_project", effects: ["read"], inputSchema: { type: "object" }, validate(args) { object(args); },
      async execute(_, context) { context.signal?.throwIfAborted(); const path = join(directory, "project.json"), stat = await lstat(path); if (!stat.isFile() || stat.size > 16384) throw new Error("Invalid project file"); return { status: "success", structuredContent: json(project(JSON.parse(await readFile(path, "utf8")))) }; } },
    { name: "memory_publish", effects: ["write"], inputSchema: { type: "object" }, validate(args) { const r = object(args.report); if (r.namespace !== namespace || typeof r.taskId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(r.taskId)) throw new Error("Invalid artifact identity"); },
      async execute(args, context) {
        context.signal?.throwIfAborted(); const r = object(args.report), dir = join(directory, "artifacts"); await mkdir(dir, { recursive: true });
        const path = join(dir, `${r.taskId}.json`), temp = `${path}.${randomUUID()}.tmp`, body = JSON.stringify(r, null, 2) + "\n";
        try { await writeFile(temp, body, { flag: "wx" }); try { await link(temp, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(path, "utf8") !== body) throw error; } }
        finally { await rm(temp, { force: true }); }
        return { status: "success", structuredContent: { file: `artifacts/${r.taskId}.json` } };
      } },
  ];
}
