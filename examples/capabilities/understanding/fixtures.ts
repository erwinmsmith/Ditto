import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Mode, Source } from "../../_shared/tools/understanding-store.ts";
export function request(topic: string, deadline = "2027-12-15T09:00:00.000Z") {
  return `请为 ${topic} 生成发布报告，面向工程团队。截止时间 ${deadline}，使用 Markdown 格式，预算人民币 25 元，仅生成本地草稿，不要发布。范围包括变更记录和指标。`;
}
export async function createFixture(directory: string, mode: Mode) {
  const source: Source = { topic: `ORION-${randomBytes(4).toString("hex")}`, changes: [`Added export ${randomBytes(4).toString("hex")}.`, "Improved startup diagnostics."], metrics: { testsPassed: 273, fixes: 4 } };
  await writeFile(join(directory, "source.json"), JSON.stringify(source, null, 2));
  await writeFile(join(directory, "application.json"), JSON.stringify({ mode }));
  const message = mode === "clarification" ? `请为 ${source.topic} 生成面向工程团队的发布报告。` : request(source.topic);
  return { source, message };
}
