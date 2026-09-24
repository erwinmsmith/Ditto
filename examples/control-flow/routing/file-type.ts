import { graph } from "@codesoul-co/ditto/runtime";
import { fileToolNames } from "../../_shared/tools/file-ingestion/index.ts";
import { basename, dirname, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createFileTools } from "../../_shared/tools/file-ingestion/index.ts";
import { cli, deliver, extractInstruction, isMain, record, sampleGraph, type Request, type Runner } from "./shared.ts";

/** The ingestion adapter supplies extracted content, after validating the actual file bytes. */
export type ParsedFile =
  | { readonly name: string; readonly mediaType: "application/pdf"; readonly text: string }
  | { readonly name: string; readonly mediaType: "text/csv" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; readonly rows: readonly (readonly string[])[] }
  | { readonly name: string; readonly mediaType: "image/png" | "image/jpeg"; readonly ocrText: string }
  | { readonly name: string; readonly mediaType: "audio/wav" | "audio/mpeg"; readonly transcript: string };
export type FileTypeInput = Omit<Request, "text"> & { readonly file: ParsedFile };
const handlers = {
  pdf: sampleGraph("file-pdf", `Read the extracted PDF text. ${extractInstruction}`),
  spreadsheet: sampleGraph("file-spreadsheet", `Read the table rows; row zero contains column names. ${extractInstruction}`),
  image: sampleGraph("file-image", `Read the OCR text from the image. ${extractInstruction}`),
  audio: sampleGraph("file-audio", `Read the audio transcript. ${extractInstruction}`),
};
export function selectFileKind(file: { readonly name: string; readonly mediaType: string }) {
  const extension = extname(file.name).toLowerCase();
  const allowed: Record<string, readonly string[]> = {
    "application/pdf": [".pdf"], "text/csv": [".csv"],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
    "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "audio/wav": [".wav"], "audio/mpeg": [".mp3"],
  };
  if (!Object.hasOwn(allowed, file.mediaType) || !allowed[file.mediaType]?.includes(extension)) throw new Error("Unsupported or mismatched file type");
  return file.mediaType === "application/pdf" ? "pdf"
    : file.mediaType === "text/csv" || file.mediaType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ? "spreadsheet"
    : file.mediaType.startsWith("image/") ? "image" : "audio";
}
export function selectFile(file: ParsedFile) {
  selectFileKind(file);
  if (file.mediaType === "text/csv" || file.mediaType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    if (!Array.isArray(file.rows) || file.rows.length < 2 || !file.rows[0]?.length
      || file.rows.some(row => !Array.isArray(row) || row.length !== file.rows[0]!.length || row.some(cell => typeof cell !== "string"))) throw new Error("Invalid table rows");
    return { route: "spreadsheet" as const, text: JSON.stringify(file.rows) };
  }
  const parsed = file.mediaType === "application/pdf" ? { route: "pdf" as const, text: file.text }
    : file.mediaType === "image/png" || file.mediaType === "image/jpeg" ? { route: "image" as const, text: file.ocrText }
    : { route: "audio" as const, text: "transcript" in file ? file.transcript : "" };
  if (typeof parsed.text !== "string" || !parsed.text.trim()) throw new Error("Missing extracted file content");
  return parsed;
}
export async function runFileType(runtime: Runner, input: FileTypeInput) {
  if (!input.id.trim()) throw new Error("Request id must be nonempty");
  const selected = selectFile(input.file);
  const output = await runtime.run(handlers[selected.route], { id: input.id, model: input.model, text: selected.text });
  const content = { route: selected.route, file: input.file.name, ...record(output.sample) };
  const receipt = await deliver(runtime, input.id, content);
  return { content, samples: [output.sample], receipt };
}
export interface FileTaskInput extends Omit<Request, "text"> {
  readonly file: { readonly path: string; readonly name: string; readonly mediaType: string };
}
const parseGraph = graph<FileTaskInput & { tool: string }>("file-ingestion")
  .node("parsed", "INTERACTION.ACT.TOOL", [], input => ({ call: {
    id: `${input.id}:parse`, name: input.tool, arguments: { path: input.file.path, mediaType: input.file.mediaType },
  } }));
/** Original file -> selected parser tool -> selected inference Graph -> delivery. */
export async function runFileTask(runtime: Runner, input: FileTaskInput) {
  if (!input.id.trim()) throw new Error("Request id must be nonempty");
  const kind = selectFileKind(input.file);
  const parsed = await runtime.run(parseGraph, { ...input, tool: fileToolNames[kind] });
  if (parsed.parsed.status !== "success") throw new Error(`File parser failed: ${parsed.parsed.status}`);
  const data = parsed.parsed.structuredContent;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid parser result");
  const file = data as unknown as ParsedFile;
  if (file.name !== input.file.name || file.mediaType !== input.file.mediaType) throw new Error("Parser result does not match the requested file");
  selectFile(file); // Validate the external adapter result before inference.
  const result = await runFileType(runtime, { id: input.id, model: input.model, file });
  return { ...result, parsed: data };
}
if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { file: { type: "string" }, "media-type": { type: "string" } } });
  if (!values.file || !values["media-type"]) throw new Error("Pass --file <path> --media-type <MIME>; see the file ingestion tool README for dependencies");
  const path = resolve(values.file);
  const tools = createFileTools({ root: process.env.DITTO_EXAMPLE_INPUT_ROOT ?? dirname(path),
    python: resolve(process.env.DITTO_EXAMPLE_TOOLS_PYTHON ?? "examples/_shared/tools/.venv/bin/python"),
    pdftotext: process.env.DITTO_EXAMPLE_PDFTOTEXT ?? "pdftotext", tesseract: process.env.DITTO_EXAMPLE_TESSERACT ?? "tesseract",
    asrModel: process.env.DITTO_EXAMPLE_ASR_MODEL ?? "tiny.en",
  });
  await cli((runtime, model) => runFileTask(runtime, { id: "file-task", model,
    file: { path, name: basename(path), mediaType: values["media-type"]! },
  }), tools);
}
