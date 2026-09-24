import { createHash } from "node:crypto";
import type { JsonValue } from "@ditto/core/contracts";
export const modes = [
  "document-parsing",
  "document-comparison",
  "document-review",
  "image-understanding",
  "chart-understanding",
  "audio-transcription",
  "video-understanding",
  "meeting-notes",
] as const;
export type Mode = (typeof modes)[number];
export interface Source {
  id: string;
  path: string;
  mediaType: string;
  sha256: string;
}
export interface Request {
  id: string;
  tenant: string;
  mode: Mode;
  sources: Source[];
  instruction: string;
}
export interface Block {
  location: string;
  text: string;
}
export interface ImageRef {
  location: string;
  path: string;
  sha256: string;
  mediaType: string;
}
export interface Material {
  sources: (Source & {
    engine: string;
    blocks: Block[];
    images: ImageRef[];
    details: Record<string, JsonValue>;
  })[];
}
export interface Finding {
  statement: string;
  sourceId: string;
  location: string;
  quote: string;
}
export interface Analysis {
  summary: string;
  findings: Finding[];
  data: Record<string, JsonValue>;
  limitations: string[];
}
export const digest = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
export const json = (v: unknown): JsonValue =>
  JSON.parse(JSON.stringify(v)) as JsonValue;
export function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Expected object");
  return v as Record<string, unknown>;
}
export function string(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > 32000)
    throw new Error("Expected nonempty bounded string");
  return v;
}
export function request(v: Request): Request {
  if (
    !/^[\w-]{1,80}$/.test(v.id) ||
    !/^[\w-]{1,80}$/.test(v.tenant) ||
    !modes.includes(v.mode)
  )
    throw new Error("Invalid task identity");
  string(v.instruction);
  if (!Array.isArray(v.sources) || !v.sources.length || v.sources.length > 4)
    throw new Error("Provide 1-4 sources");
  const ids = new Set<string>();
  for (const s of v.sources) {
    if (
      !/^[\w-]{1,60}$/.test(s.id) ||
      ids.has(s.id) ||
      !/^[a-f0-9]{64}$/.test(s.sha256)
    )
      throw new Error("Invalid source identity");
    ids.add(s.id);
    string(s.path);
    string(s.mediaType);
  }
  const allowed = v.mode.startsWith("document-")
    ? [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ]
    : v.mode === "video-understanding"
      ? ["video/mp4"]
      : ["audio-transcription", "meeting-notes"].includes(v.mode)
        ? ["audio/wav", "audio/mpeg"]
        : ["image/png", "image/jpeg"];
  if (v.sources.some((s) => !allowed.includes(s.mediaType)))
    throw new Error("Media type does not match the capability");
  if (v.mode === "document-comparison" && v.sources.length < 2)
    throw new Error("Comparison requires multiple documents");
  return JSON.parse(JSON.stringify(v)) as Request;
}
export function material(value: unknown, r: Request): Material {
  const v = object(value);
  if (!Array.isArray(v.sources) || v.sources.length !== r.sources.length)
    throw new Error("Source count mismatch");
  for (let n = 0; n < v.sources.length; n++) {
    const s = object(v.sources[n]),
      expected = r.sources[n]!;
    if (
      s.id !== expected.id ||
      s.sha256 !== expected.sha256 ||
      s.mediaType !== expected.mediaType ||
      s.path !== expected.path
    )
      throw new Error("Source identity mismatch");
    string(s.engine);
    object(s.details);
    if (
      !Array.isArray(s.blocks) ||
      !Array.isArray(s.images) ||
      (!s.blocks.length && !s.images.length) ||
      s.images.length > 3
    )
      throw new Error("Empty or oversized material");
    const locations = new Set<string>();
    for (const b of s.blocks) {
      const o = object(b);
      string(o.location);
      string(o.text);
      if (locations.has(String(o.location)))
        throw new Error("Duplicate location");
      locations.add(String(o.location));
    }
    for (const b of s.images) {
      const o = object(b);
      string(o.location);
      string(o.path);
      if (
        o.mediaType !== "image/jpeg" ||
        !/^[a-f0-9]{64}$/.test(String(o.sha256)) ||
        locations.has(String(o.location))
      )
        throw new Error("Invalid image reference");
      locations.add(String(o.location));
    }
  }
  if (JSON.stringify(v).length > 48000)
    throw new Error("Material exceeds context budget");
  return value as Material;
}
export const requirements: Record<Mode, string> = {
  "document-parsing":
    "Understand all documents. data={subject:string,keyPoints:string[]}. Cite PDF pages and Word paragraphs.",
  "document-comparison":
    "Compare all supplied documents. data={common:string[],differences:[{field:string,before:string,after:string}]}. Include evidence from every version.",
  "document-review":
    'Review against ONLY the rules in the instruction. data={issues:[{rule:string,type:"missing"|"violation",explanation:string}]}. Missing fields are absence claims, not invented quotes.',
  "image-understanding":
    'Understand actual image pixels. data={objects:[{shape:string,color:string,position:"left"|"center"|"right"}]}. Do not infer hidden objects.',
  "chart-understanding":
    "Read actual chart pixels and numeric labels. data={series:[{label:string,value:number}],maximum:string,change:number}. maximum MUST be the category label of the highest bar, NOT the numeric value. change=last minus first. Every finding quotes pixels, so quote MUST be the empty string, never a number read from the chart. If unreadable, fail instead of guessing.",
  "audio-transcription":
    "Understand the verbatim audio transcript. data={topics:string[]}. The original ASR transcript is preserved separately, never replace it with this summary.",
  "video-understanding":
    "Analyze the timestamped video frames. data={events:[{location:string,description:string}],direction:string}. Each events[].location MUST copy an exact image location label such as seconds:0.6 from allowedImageLocations; location is a frame timestamp identifier, never a spatial description or background. State that frames are sampled, unsampled intervals and audio are not analyzed. Cite every frame.",
  "meeting-notes":
    "Organize the transcribed meeting. data={decisions:string[],actions:[{owner:string,task:string,due:string}],openQuestions:string[]}. Preserve relative deadlines; use unspecified when absent, never invent dates or speaker identities.",
};
function list(v: unknown, min = 0): unknown[] {
  if (!Array.isArray(v) || v.length < min || v.length > 64)
    throw new Error("Invalid list");
  return v;
}
function strings(v: unknown, min = 0) {
  list(v, min).forEach(string);
}
export function analysis(value: unknown, r: Request, m: Material): Analysis {
  const a = object(value);
  string(a.summary);
  strings(a.limitations);
  const d = object(a.data);
  const seen = new Set<string>();
  for (const v of list(a.findings, 1)) {
    const f = object(v);
    string(f.statement);
    const s = m.sources.find((s) => s.id === f.sourceId);
    if (!s || typeof f.quote !== "string")
      throw new Error("Unknown evidence source");
    const b = s.blocks.find((b) => b.location === f.location),
      im = s.images.find((i) => i.location === f.location);
    if (
      (!b && !im) ||
      (b && (!f.quote.trim() || !b.text.includes(f.quote))) ||
      (im && f.quote !== "")
    )
      throw new Error("Evidence location or exact quotation invalid");
    seen.add(s.id + ":" + String(f.location));
  }
  for (const s of m.sources)
    if (![...seen].some((key) => key.startsWith(s.id + ":")))
      throw new Error("Every source needs evidence");
  switch (r.mode) {
    case "document-parsing":
      string(d.subject);
      strings(d.keyPoints, 1);
      break;
    case "document-comparison":
      strings(d.common);
      for (const v of list(d.differences)) {
        const x = object(v);
        string(x.field);
        string(x.before);
        string(x.after);
      }
      break;
    case "document-review":
      for (const v of list(d.issues)) {
        const x = object(v);
        string(x.rule);
        string(x.explanation);
        if (!["missing", "violation"].includes(String(x.type)))
          throw new Error("Invalid issue");
      }
      break;
    case "image-understanding":
      for (const v of list(d.objects, 1)) {
        const x = object(v);
        string(x.shape);
        string(x.color);
        if (!["left", "center", "right"].includes(String(x.position)))
          throw new Error("Invalid position");
      }
      break;
    case "chart-understanding": {
      const rows = list(d.series, 2).map((v) => object(v));
      for (const x of rows) {
        string(x.label);
        if (typeof x.value !== "number" || !Number.isFinite(x.value))
          throw new Error("Invalid chart value");
      }
      const max = Math.max(...rows.map((x) => x.value as number));
      if (
        !rows.some((x) => x.label === d.maximum && x.value === max) ||
        d.change !== (rows.at(-1)!.value as number) - (rows[0]!.value as number)
      )
        throw new Error("Chart arithmetic mismatch");
      break;
    }
    case "audio-transcription":
      strings(d.topics, 1);
      break;
    case "video-understanding":
      string(d.direction);
      for (const v of list(d.events, 1)) {
        const x = object(v);
        string(x.description);
        if (
          !m.sources.some((s) =>
            s.images.some((im) => im.location === x.location),
          )
        )
          throw new Error("Unknown event timestamp");
      }
      for (const s of m.sources)
        for (const im of s.images)
          if (!seen.has(s.id + ":" + im.location))
            throw new Error("Every sampled frame needs evidence");
      if (!list(a.limitations).length)
        throw new Error("Sampling limitations required");
      break;
    case "meeting-notes":
      strings(d.decisions);
      strings(d.openQuestions);
      for (const v of list(d.actions)) {
        const x = object(v);
        string(x.owner);
        string(x.task);
        string(x.due);
      }
      break;
  }
  return value as Analysis;
}
