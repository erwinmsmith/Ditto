import { readFile, writeFile, mkdir, link, rm, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import {
  json,
  source,
  validateMaterial,
  validateDraft,
  validateReview,
  digest,
  type Request,
} from "./domain.ts";
import { render } from "./render.ts";
async function immutable(path: string, content: string) {
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, content, { flag: "wx" });
    try {
      await link(temp, path);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !(await lstat(path)).isFile() ||
        (await readFile(path, "utf8")) !== content
      )
        throw error;
    }
    if ((await readFile(path, "utf8")) !== content)
      throw new Error("Artifact readback mismatch");
  } finally {
    await rm(temp, { force: true });
  }
}
export function contentTools(directory: string, r: Request): RegisteredTool[] {
  return [
    {
      name: "content_sources",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      effects: ["read"],
      validate: (args) => {
        if (Object.keys(args).length)
          throw new Error("Sources are selected by the controller");
      },
      execute: async (_, context) => {
        const sources = [];
        for (const s of r.sources) {
          context.signal?.throwIfAborted();
          const path = join(directory, "inputs", s.file),
            stat = await lstat(path);
          if (!stat.isFile() || stat.size > 16384)
            throw new Error("Invalid source file");
          const content = await readFile(path, "utf8");
          if (digest(content) !== s.sha256)
            throw new Error("Source snapshot mismatch");
          sources.push(source(s.id, s.file, content));
        }
        return {
          status: "success",
          structuredContent: json(validateMaterial({ sources }, r)),
        };
      },
    },
    {
      name: "content_publish",
      inputSchema: { type: "object" },
      effects: ["write"],
      validate: (args) => {
        if (Object.keys(args).sort().join() !== "draft,material,review")
          throw new Error("Invalid publication fields");
      },
      execute: async (args, context) => {
        const material = validateMaterial(args.material, r),
          draft = validateDraft(args.draft, r, material),
          review = validateReview(args.review),
          files = render(draft, material, review),
          root = join(directory, "artifacts");
        await mkdir(root, { recursive: true });
        if (!(await lstat(root)).isDirectory())
          throw new Error("Invalid artifact directory");
        for (const [name, content] of Object.entries(files)) {
          context.signal?.throwIfAborted();
          const parent = dirname(join(root, name));
          await mkdir(parent, { recursive: true });
          if (!(await lstat(parent)).isDirectory())
            throw new Error("Invalid artifact directory");
          await immutable(join(root, name), content);
        }
        return {
          status: "success",
          structuredContent: {
            files: Object.entries(files).map(([file, content]) => ({
              file,
              sha256: digest(content),
              bytes: Buffer.byteLength(content),
            })),
          },
        };
      },
    },
  ];
}
