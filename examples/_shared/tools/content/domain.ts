import { createHash } from "node:crypto";
import type { JsonValue } from "@ditto/core/contracts";
export const modes = [
  "generate",
  "rewrite",
  "summarize",
  "expand",
  "translate",
  "convert",
  "cite",
] as const;
export type Mode = (typeof modes)[number];
export interface Request {
  id: string;
  tenant: string;
  mode: Mode;
  anchors: string[];
  sources: { id: string; file: string; sha256: string }[];
}
export interface Block {
  id: string;
  line: number;
  text: string;
}
export interface Source {
  id: string;
  file: string;
  sha256: string;
  content: string;
  blocks: Block[];
}
export interface Material {
  sources: Source[];
}
export interface Citation {
  blockId: string;
  quote: string;
}
export interface Draft {
  title: string;
  language: "zh-CN" | "en";
  sections: { heading: string; text: string; citations: Citation[] }[];
}
export interface Review {
  approved: boolean;
  checks: {
    fidelity: boolean;
    coverage: boolean;
    transformation: boolean;
    citations: boolean;
  };
  issues: string[];
}
export const json = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v));
export const digest = (v: string) =>
  createHash("sha256").update(v).digest("hex");
export const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Expected object");
  return v as Record<string, unknown>;
};
function text(v: unknown, max: number): string {
  if (typeof v !== "string" || !v.trim() || v.length > max || /[\0\r]/.test(v))
    throw new Error("Invalid bounded text");
  return v;
}
export function request(v: unknown): Request {
  const r = object(v);
  for (const k of ["id", "tenant"])
    if (typeof r[k] !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(r[k]))
      throw new Error(`Invalid ${k}`);
  if (
    !modes.includes(r.mode as Mode) ||
    !Array.isArray(r.anchors) ||
    r.anchors.length !== 3 ||
    !Array.isArray(r.sources) ||
    r.sources.length !== 3
  )
    throw new Error("Invalid content request");
  const sources = r.sources.map((v) => {
    const s = object(v);
    if (
      !["brief", "notes", "draft"].includes(String(s.id)) ||
      s.file !== `${s.id}.md` ||
      typeof s.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(s.sha256)
    )
      throw new Error("Invalid source descriptor");
    return { id: String(s.id), file: String(s.file), sha256: s.sha256 };
  });
  if (new Set(sources.map((s) => s.id)).size !== 3)
    throw new Error("Duplicate source");
  return {
    id: String(r.id),
    tenant: String(r.tenant),
    mode: r.mode as Mode,
    anchors: r.anchors.map((v) => text(v, 80)),
    sources,
  };
}
export function source(id: string, file: string, content: string): Source {
  text(content, 16384);
  return {
    id,
    file,
    content,
    sha256: digest(content),
    blocks: content
      .split("\n")
      .flatMap((line, i) =>
        line.trim() && !line.startsWith("#")
          ? [{ id: `${id}:${i + 1}`, line: i + 1, text: line }]
          : [],
      ),
  };
}
export function validateMaterial(v: unknown, r: Request): Material {
  const material = object(v);
  if (
    !Array.isArray(material.sources) ||
    material.sources.length !== r.sources.length
  )
    throw new Error("Missing source material");
  const rawSources = material.sources;
  const sources = r.sources.map((expected) => {
    const raw = object(
      rawSources.find((v: unknown) => object(v).id === expected.id),
    );
    const rebuilt = source(
      expected.id,
      expected.file,
      text(raw.content, 16384),
    );
    if (
      raw.file !== expected.file ||
      raw.sha256 !== rebuilt.sha256 ||
      rebuilt.sha256 !== expected.sha256 ||
      JSON.stringify(raw.blocks) !== JSON.stringify(rebuilt.blocks)
    )
      throw new Error("Source snapshot mismatch");
    return rebuilt;
  });
  return { sources };
}
export const maxLength: Record<Mode, number> = {
  generate: 850,
  rewrite: 650,
  summarize: 380,
  expand: 1500,
  translate: 2000,
  convert: 1500,
  cite: 1000,
};
export function requirement(mode: Mode): string {
  return {
    generate:
      "根据资料生成面向试点团队的新通知，说明产品、开放日期、每日配额、人工审批要求与数据导出限制。使用清晰标题和正文，不能照搬整篇草稿。",
    rewrite:
      "将 draft 改写为更清晰、礼貌、简洁的团队通知；调整句式与组织方式，保留全部关键事实，不能原样复制整篇草稿。",
    summarize:
      "总结 brief、notes 中的重要信息，去除讨论过程与重复内容；正文总长不超过 380 字，保留产品、日期、配额、审批与导出限制。",
    expand:
      "以 draft 第一段为开头，第一节正文必须逐字保留该段；增加完整的启用说明与申请步骤，覆盖所有 brief 事实并引用 notes。新增内容必须来自材料，正文应明显长于原始首段。",
    translate:
      "将 draft 的全部正文翻译成自然英文，不补充草稿以外的信息；保留产品编号、ISO 日期、数字以及限定条件。术语：人工审批=manual approval，数据导出=data export，NimbusDesk 不翻译。",
    convert:
      "将 draft 解析成可渲染的结构化内容：title 与原文 Markdown 标题相同；每个正文段落成为一个 section，顺序和 text 必须逐字保留，citations 指向对应 draft 原段落。只改变展示格式，不改写正文。",
    cite: "根据 brief 和 notes 写一份带出处的启用指南；每节附支持该节陈述的原文引文，覆盖全部 brief 事实并包含申请步骤，引用至少两个来源。",
  }[mode];
}
/** Immutable source text is retained by the controller; the model supplies only additions. */
export function assembleDraft(
  value: unknown,
  r: Request,
  material: Material,
): unknown {
  if (r.mode !== "expand") return value;
  const draft = object(value);
  if (!Array.isArray(draft.sections))
    throw new Error("Missing expansion sections");
  const lead = material.sources.find((s) => s.id === "draft")!.blocks[0]!;
  const supporting = material.sources
    .flatMap((s) => s.blocks)
    .filter((b) => b.id === lead.id || b.text === lead.text);
  return {
    ...draft,
    sections: [
      {
        heading: "原始内容",
        text: lead.text,
        citations: supporting.map((b) => ({ blockId: b.id, quote: b.text })),
      },
      ...draft.sections,
    ],
  };
}
export function validateDraft(v: unknown, r: Request, m: Material): Draft {
  const d = object(v);
  if (
    Object.keys(d).sort().join() !== "language,sections,title" ||
    !Array.isArray(d.sections) ||
    d.sections.length < 1 ||
    d.sections.length > 7 ||
    d.language !== (r.mode === "translate" ? "en" : "zh-CN")
  )
    throw new Error("Invalid draft schema or language");
  const blocks = m.sources.flatMap((s) => s.blocks),
    seen = new Set<string>();
  const sections = d.sections.map((v) => {
    const s = object(v);
    if (
      Object.keys(s).sort().join() !== "citations,heading,text" ||
      !Array.isArray(s.citations) ||
      !s.citations.length ||
      s.citations.length > 12
    )
      throw new Error("Missing section citations");
    const citations = s.citations.map((v) => {
      const c = object(v),
        block = blocks.find((b) => b.id === c.blockId);
      if (
        Object.keys(c).sort().join() !== "blockId,quote" ||
        !block ||
        c.quote !== block.text
      )
        throw new Error("Unsupported citation quote or location");
      seen.add(block.id);
      return { blockId: block.id, quote: block.text };
    });
    if (new Set(citations.map((c) => c.blockId)).size !== citations.length)
      throw new Error("Duplicate section citation");
    return {
      heading: text(s.heading, 100),
      text: text(s.text, maxLength[r.mode]),
      citations,
    };
  });
  const out: Draft = {
      title: text(d.title, 150),
      language: r.mode === "translate" ? "en" : "zh-CN",
      sections,
    },
    body = sections.map((s) => s.text).join("\n"),
    original = m.sources.find((s) => s.id === "draft")!;
  if (
    body.length > maxLength[r.mode] ||
    r.anchors.some((anchor) => !body.includes(anchor))
  )
    throw new Error("Missing protected fact or output exceeds length");
  if (
    r.mode === "translate"
      ? /[\u3400-\u9fff]/.test(
          out.title + sections.map((s) => s.heading + s.text).join(""),
        )
      : !/[\u3400-\u9fff]/.test(body)
  )
    throw new Error("Output language mismatch");
  const required = ["convert", "translate", "rewrite"].includes(r.mode)
    ? original.blocks
    : m.sources.find((s) => s.id === "brief")!.blocks;
  if (required.some((b) => !seen.has(b.id)))
    throw new Error("Required source coverage missing");
  const allowedNumbers = new Set(
    m.sources.flatMap((s) => s.content.match(/\d+/g) ?? []),
  );
  if ((body.match(/\d+/g) ?? []).some((n) => !allowedNumbers.has(n)))
    throw new Error("Unsupported numerical claim");
  if (
    r.mode === "translate" &&
    (!/manual approval/i.test(body) || !/data export/i.test(body))
  )
    throw new Error("Required translation glossary missing");
  if (
    ["generate", "rewrite"].includes(r.mode) &&
    body === original.blocks.map((b) => b.text).join("\n")
  )
    throw new Error("Content was not transformed");
  if (
    r.mode === "expand" &&
    (sections[0]!.text !== original.blocks[0]!.text ||
      body.length < original.blocks[0]!.text.length + 80 ||
      ![...seen].some((id) => id.startsWith("notes:")))
  )
    throw new Error(
      "Expansion must preserve the lead and add supported material",
    );
  if (
    r.mode === "cite" &&
    (!seen.has(m.sources.find((s) => s.id === "notes")!.blocks[0]!.id) ||
      new Set([...seen].map((id) => id.split(":")[0])).size < 2)
  )
    throw new Error("Citation source diversity missing");
  if (
    r.mode === "convert" &&
    (out.title !== original.content.split("\n")[0]!.replace(/^# /, "") ||
      sections.length !== original.blocks.length ||
      sections.some(
        (s, i) =>
          s.text !== original.blocks[i]!.text ||
          s.citations.length !== 1 ||
          s.citations[0]!.blockId !== original.blocks[i]!.id,
      ))
  )
    throw new Error("Format conversion changed source content");
  return out;
}
export function validateReview(v: unknown): Review {
  const r = object(v),
    c = object(r.checks);
  if (
    Object.keys(r).sort().join() !== "approved,checks,issues" ||
    Object.keys(c).sort().join() !==
      "citations,coverage,fidelity,transformation" ||
    typeof r.approved !== "boolean" ||
    Object.values(c).some((v) => typeof v !== "boolean") ||
    !Array.isArray(r.issues) ||
    r.issues.length > 10
  )
    throw new Error("Invalid review schema");
  const issues = r.issues.map((v) => text(v, 1000));
  if (!r.approved || Object.values(c).some((v) => !v) || issues.length)
    throw new Error(
      `Content review rejected the draft: ${issues.join("; ") || "one or more checks failed"}`,
    );
  return {
    approved: true,
    checks: {
      fidelity: true,
      coverage: true,
      transformation: true,
      citations: true,
    },
    issues,
  };
}
