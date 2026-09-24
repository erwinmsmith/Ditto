import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
  rename,
} from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import {
  analysis,
  digest,
  json,
  material,
  object,
  type Request,
  type Material,
} from "./domain.ts";
const exec = promisify(execFile);
export interface MediaConfig {
  python: string;
  ffmpeg?: string;
  ffprobe?: string;
  asrModel?: string;
  asrLanguage?: string;
  timeoutMs?: number;
}
export const toolNames = [
  "multimodal_read",
  "multimodal_images",
  "multimodal_publish",
];
async function contained(root: string, path: string) {
  const full = await realpath(resolve(root, path)),
    base = await realpath(root),
    rel = relative(base, full);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../"))
    throw new Error("File outside media root");
  return full;
}
async function bytes(root: string, path: string, sha: string) {
  const full = await contained(root, path),
    info = await stat(full);
  if (!info.isFile() || !info.size || info.size > 50 * 1024 * 1024)
    throw new Error("File must be 1 byte to 50 MiB");
  const b = await readFile(full);
  if (digest(b) !== sha) throw new Error("Source checksum mismatch");
  return b;
}
export function mediaTools(
  directory: string,
  r: Request,
  config: MediaConfig,
): RegisteredTool[] {
  const root = resolve(directory),
    snapshots = join(root, "snapshots");
  return [
    {
      name: "multimodal_read",
      effects: ["read", "write", "execute"],
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      validate(args) {
        if (Object.keys(args).length) throw new Error("Unexpected arguments");
      },
      async execute(_args, context) {
        const sources: Material["sources"] = [];
        await mkdir(snapshots, { recursive: true });
        for (const s of r.sources) {
          context.signal?.throwIfAborted();
          const b = await bytes(root, s.path, s.sha256),
            path = join(snapshots, s.id + "-" + s.sha256),
            output = join(snapshots, s.id + "-images");
          await writeFile(path, b);
          const { stdout } = await exec(
            config.python,
            [
              fileURLToPath(new URL("./parse.py", import.meta.url)),
              path,
              s.mediaType,
              output,
              "--asr-model",
              config.asrModel ?? "tiny.en",
              "--asr-language",
              config.asrLanguage ?? "en",
              "--ffmpeg",
              config.ffmpeg ?? "ffmpeg",
              "--ffprobe",
              config.ffprobe ?? "ffprobe",
            ],
            {
              signal: context.signal,
              timeout: config.timeoutMs ?? 240000,
              maxBuffer: 2 * 1024 * 1024,
              env: {
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                HOME: process.env.HOME ?? root,
                PYTHONIOENCODING: "utf-8",
              },
            },
          );
          const decoded = object(JSON.parse(stdout));
          const entry = { ...decoded, ...s } as Material["sources"][number];
          entry.images = entry.images.map((im) => ({
            ...im,
            path: relative(root, im.path),
          }));
          sources.push(entry);
        }
        const result = material({ sources }, r);
        return { status: "success", structuredContent: json(result) };
      },
    },
    {
      name: "multimodal_images",
      effects: ["read"],
      inputSchema: {
        type: "object",
        required: ["material"],
        properties: { material: { type: "object" } },
        additionalProperties: false,
      },
      validate(args) {
        material(args.material, r);
      },
      async execute(args) {
        const m = material(args.material, r),
          images = [];
        for (const s of m.sources)
          for (const im of s.images) {
            const b = await bytes(snapshots, resolve(root, im.path), im.sha256);
            images.push({
              sourceId: s.id,
              location: im.location,
              url: "data:image/jpeg;base64," + b.toString("base64"),
            });
          }
        return { status: "success", structuredContent: json({ images }) };
      },
    },
    {
      name: "multimodal_publish",
      effects: ["read", "write"],
      inputSchema: {
        type: "object",
        required: ["material", "analysis"],
        properties: {
          material: { type: "object" },
          analysis: { type: "object" },
        },
        additionalProperties: false,
      },
      validate(args) {
        analysis(args.analysis, r, material(args.material, r));
      },
      async execute(args, context) {
        const m = material(args.material, r),
          a = analysis(args.analysis, r, m),
          output = join(root, "output");
        // Recheck immutable evidence before delivering or reconciling a saved report.
        for (const s of m.sources) {
          await bytes(snapshots, s.id + "-" + s.sha256, s.sha256);
          for (const im of s.images)
            await bytes(snapshots, resolve(root, im.path), im.sha256);
        }
        await mkdir(output, { recursive: true });
        const provenance = m.sources.map(
          ({ id, sha256, mediaType, engine, blocks, images, details }) => ({
            id,
            sha256,
            mediaType,
            engine,
            blocks,
            images,
            details,
          }),
        );
        const markdown =
          `# ${r.mode}\n\n${a.summary}\n\n` +
          a.findings
            .map(
              (f) =>
                `- ${f.statement} [${f.sourceId}, ${f.location}]${f.quote ? `\n  > ${f.quote}` : ""}`,
            )
            .join("\n") +
          "\n\n## Structured result\n\n```json\n" +
          JSON.stringify(a.data, null, 2) +
          "\n```\n\n## Limitations\n\n" +
          a.limitations.map((x) => "- " + x).join("\n") +
          "\n";
        const files = [
          {
            file: "report.json",
            body:
              JSON.stringify(
                { taskId: r.id, mode: r.mode, analysis: a, provenance },
                null,
                2,
              ) + "\n",
          },
          { file: "report.md", body: markdown },
        ];
        for (const s of m.sources)
          if (typeof s.details.transcript === "string")
            files.push({
              file: s.id + "-transcript.txt",
              body: s.details.transcript + "\n",
            });
        for (const f of files) {
          context.signal?.throwIfAborted();
          const path = join(output, f.file),
            old = await readFile(path, "utf8").catch(
              (e: NodeJS.ErrnoException) => {
                if (e.code !== "ENOENT") throw e;
                return undefined;
              },
            );
          if (old !== undefined && old !== f.body)
            throw new Error("Published artifact was changed");
          if (old === undefined) {
            const tmp = path + ".tmp";
            await writeFile(tmp, f.body);
            await rename(tmp, path);
          }
        }
        return {
          status: "success",
          structuredContent: json({
            files: files.map((f) => ({
              file: "output/" + f.file,
              sha256: digest(f.body),
              bytes: Buffer.byteLength(f.body),
            })),
          }),
        };
      },
    },
  ];
}
