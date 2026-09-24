import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, randomInt } from "node:crypto";
import { digest, request, type Mode, type Request } from "./domain.ts";
export async function createFixture(
  directory: string,
  mode: Mode,
): Promise<Request> {
  await mkdir(join(directory, "inputs"), { recursive: true });
  const product = `ND-${randomInt(10000, 99999)}`,
    date = `2026-10-${randomInt(10, 28)}`,
    quota = String(randomInt(25, 85));
  const facts = [
    `NimbusDesk ${product} 是面向已登记团队的杭州试点服务。`,
    `试点开放日期为 ${date}。`,
    `每个团队每天最多可提交 ${quota} 个任务。`,
    `启用前必须获得人工审批；试点不提供自动数据导出。`,
  ];
  const content: Record<string, string> = {
    brief: "# 已批准的试点资料\n" + facts.join("\n") + "\n",
    draft: `# NimbusDesk 试点通知\nNimbusDesk ${product} 是面向已登记团队的杭州试点服务。\n我们这边已经确认了，试点开放日期就是 ${date}，请大家留意一下。\n关于任务数量，每个团队每天最多可提交 ${quota} 个任务，请大家不要超出这个数量。\n还有一个事情要特别说一下：启用前必须获得人工审批；试点不提供自动数据导出。\n`,
    notes:
      "# 启用讨论纪要\n申请步骤：提交租户编号并选择杭州试点，审批通过后才可启用。\n维护说明：遇到启用问题时联系团队管理员，不自行绕过审批。\n" +
      Array.from(
        { length: 18 },
        () =>
          "会议讨论了通知的排版和发送顺序；这些讨论不改变已批准的开放日期、配额和审批规则。",
      ).join("\n") +
      "\n",
  };
  const sources = [];
  for (const id of ["brief", "notes", "draft"]) {
    const file = id + ".md";
    await writeFile(join(directory, "inputs", file), content[id]!);
    sources.push({ id, file, sha256: digest(content[id]!) });
  }
  const r: Request = {
    id: randomUUID(),
    tenant: "team-a",
    mode,
    anchors: [product, date, quota],
    sources,
  };
  await writeFile(join(directory, "request.json"), JSON.stringify(r));
  return r;
}
export async function resumeFixture(directory: string) {
  return request(
    JSON.parse(await readFile(join(directory, "request.json"), "utf8")),
  );
}
