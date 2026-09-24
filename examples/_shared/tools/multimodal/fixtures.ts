import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { digest, request, type Request, type Mode } from "./domain.ts";
export async function createFixture(
  directory: string,
  mode: Mode,
  python: string,
): Promise<Request> {
  await mkdir(directory, { recursive: true });
  await promisify(execFile)(
    python,
    [fileURLToPath(new URL("./fixtures.py", import.meta.url)), directory, mode],
    { timeout: 60000 },
  );
  const fixture = JSON.parse(
    await readFile(join(directory, "fixture.json"), "utf8"),
  ) as Omit<Request, "id" | "tenant" | "mode">;
  for (const s of fixture.sources)
    s.sha256 = digest(await readFile(join(directory, s.path)));
  const r = request({ id: randomUUID(), tenant: "demo", mode, ...fixture });
  await writeFile(join(directory, "request.json"), JSON.stringify(r, null, 2));
  return r;
}
export async function resumeFixture(directory: string): Promise<Request> {
  return request(
    JSON.parse(await readFile(join(directory, "request.json"), "utf8")),
  );
}
