import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { JsonObject } from "@codesoul-co/ditto/contracts";
import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";

const exec = promisify(execFile);
export interface FileToolConfig {
  readonly root: string;
  readonly python: string;
  readonly pdftotext?: string;
  readonly tesseract?: string;
  readonly asrModel?: string;
  readonly asrLanguage?: string;
  readonly timeoutMs?: number;
}
export const fileToolNames = { pdf: "decode_pdf", spreadsheet: "read_spreadsheet", image: "ocr_image", audio: "transcribe_audio" } as const;

/** External parser configuration stays in the application; Core only dispatches RegisteredTool. */
export function createFileTools(config: FileToolConfig): readonly RegisteredTool[] {
  return (Object.entries(fileToolNames) as [keyof typeof fileToolNames, string][]).map(([kind, name]) => ({
    name, effects: ["read", "execute"],
    inputSchema: { type: "object", required: ["path", "mediaType"], properties: {
      path: { type: "string" }, mediaType: { type: "string" },
    }, additionalProperties: false },
    validate(args) {
      if (typeof args.path !== "string" || !args.path.trim() || typeof args.mediaType !== "string" || !args.mediaType.trim()) throw new Error("File path and MIME are required");
    },
    async execute(args, context) {
      const root = await realpath(config.root);
      const path = await realpath(String(args.path));
      const rel = relative(root, path);
      if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw new Error("File is outside the ingestion directory");
      const info = await stat(path);
      if (!info.isFile() || info.size === 0 || info.size > 50 * 1024 * 1024) throw new Error("Input must be a nonempty file of at most 50 MiB");
      const { stdout } = await exec(config.python, [fileURLToPath(new URL("./parse.py", import.meta.url)), kind, path,
        "--media-type", String(args.mediaType), "--pdftotext", config.pdftotext ?? "pdftotext",
        "--tesseract", config.tesseract ?? "tesseract", "--asr-model", config.asrModel ?? "tiny.en", "--asr-language", config.asrLanguage ?? "en"], {
        signal: context.signal, timeout: config.timeoutMs ?? 180_000, maxBuffer: 4 * 1024 * 1024,
        // Parser subprocesses do not inherit application/provider credentials.
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? root, PYTHONIOENCODING: "utf-8" },
      });
      const parsed = JSON.parse(stdout) as JsonObject;
      return { status: "success", structuredContent: parsed };
    },
  }));
}
