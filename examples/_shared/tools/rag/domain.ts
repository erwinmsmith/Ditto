import {
  digest,
  object,
  text,
  strings,
  identifier,
  type Plan,
  type Selection,
  type Answer,
} from "../evidence.ts";
export * from "../evidence.ts";
export interface Request {
  id: string;
  tenant: string;
  principal: string;
  question: string;
  sourceIds: string[];
}
export function request(v: unknown): Request {
  const r = object(v);
  const sourceIds = strings(r.sourceIds, 20).map(identifier);
  if (!sourceIds.length || new Set(sourceIds).size !== sourceIds.length)
    throw new Error("Invalid sources");
  return {
    id: identifier(r.id),
    tenant: identifier(r.tenant),
    principal: identifier(r.principal),
    question: text(r.question, 1200),
    sourceIds,
  };
}
export interface Source {
  id: string;
  tenant: string;
  readers: string[];
  title: string;
  kind: "document" | "external" | "internal";
  ref: string;
}
export function sources(v: unknown): Source[] {
  if (!Array.isArray(v) || v.length > 100)
    throw new Error("Invalid source catalog");
  const result = v.map((raw) => {
    const s = object(raw);
    if (!["document", "external", "internal"].includes(String(s.kind)))
      throw new Error("Invalid source kind");
    const ref = text(s.ref, 240);
    if (
      s.kind === "document" &&
      (!/^[\w./-]+\.(md|txt)$/.test(ref) ||
        ref.startsWith("/") ||
        ref.split("/").includes(".."))
    )
      throw new Error("Invalid document path");
    if (
      s.kind === "internal" &&
      !ref.startsWith(`knowledge:${identifier(s.tenant)}:`)
    )
      throw new Error("Invalid knowledge key");
    return {
      id: identifier(s.id),
      tenant: identifier(s.tenant),
      readers: strings(s.readers, 100).map(identifier),
      title: text(s.title, 200),
      kind: s.kind as Source["kind"],
      ref,
    };
  });
  if (new Set(result.map((s) => s.id)).size !== result.length)
    throw new Error("Duplicate source");
  return result;
}
export interface Chunk {
  id: string;
  sourceId: string;
  kind: Source["kind"];
  title: string;
  uri: string;
  snapshot: string;
  startLine: number;
  endLine: number;
  text: string;
}
export function chunks(source: Source, raw: string): Chunk[] {
  if (!raw.trim() || raw.length > 100_000)
    throw new Error("Document must contain 1–100000 characters");
  const snapshot = digest(raw),
    lines = raw.split("\n"),
    result: Chunk[] = [];
  let start = 0,
    group: string[] = [];
  const flush = () => {
    if (group.some((s) => s.trim())) {
      const value = group.join("\n");
      result.push({
        id: digest(`${source.id}:${snapshot}:${start}`).slice(0, 24),
        sourceId: source.id,
        kind: source.kind,
        title: source.title,
        uri: `${source.kind}:${source.ref}`,
        snapshot,
        startLine: start + 1,
        endLine: start + group.length,
        text: value,
      });
    }
    group = [];
  };
  lines.forEach((line, i) => {
    if (line.length > 1600)
      throw new Error(
        "Normalize long lines before ingestion (maximum 1600 characters)",
      );
    if (!line.trim()) {
      flush();
      return;
    }
    if (group.join("\n").length + line.length > 1800) flush();
    if (!group.length) start = i;
    group.push(line);
  });
  flush();
  if (result.length > 200) throw new Error("Too many document chunks");
  return result;
}
export interface Report {
  requestId: string;
  question: string;
  plan: Plan;
  selection: Selection;
  evidence: Chunk[];
  answer: Answer;
  trace: { stage: string; detail: string }[];
  grounding: "model-checked" | "no-claims";
}
