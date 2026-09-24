import { writeFile, link, lstat, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
export async function immutable(path: string, content: string | Uint8Array) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { flag: "wx" });
    try {
      await link(temp, path);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !(await lstat(path)).isFile() ||
        !(await readFile(path)).equals(Buffer.from(content))
      )
        throw error;
    }
  } finally {
    await rm(temp, { force: true });
  }
}
