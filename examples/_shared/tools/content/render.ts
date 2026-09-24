import { digest, type Draft, type Material, type Review } from "./domain.ts";
export const htmlEscape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const markdownEscape = (text: string) =>
  text.replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, "\\$&");
export function render(
  draft: Draft,
  material: Material,
  review: Review,
): Record<string, string> {
  const cited = [
    ...new Set(
      draft.sections.flatMap((s) => s.citations.map((c) => c.blockId)),
    ),
  ];
  const references = cited.map((id, i) => {
    const source = material.sources.find((s) =>
        s.blocks.some((b) => b.id === id),
      )!,
      block = source.blocks.find((b) => b.id === id)!;
    return {
      id: `ref-${i + 1}`,
      blockId: id,
      file: `sources/${source.file}`,
      line: block.line,
      quote: block.text,
      sha256: source.sha256,
    };
  });
  const ref = (id: string) => references.find((r) => r.blockId === id)!;
  const markdown =
    `# ${markdownEscape(draft.title)}\n\n` +
    draft.sections
      .map(
        (s) =>
          `## ${markdownEscape(s.heading)}\n\n${markdownEscape(s.text)} ${s.citations.map((c) => `[${ref(c.blockId).id}](./${ref(c.blockId).file}#L${ref(c.blockId).line})`).join(" ")}`,
      )
      .join("\n\n") +
    "\n\n## Sources\n\n" +
    references
      .map(
        (r) =>
          `- ${r.id}: ${r.file}:${r.line} — ${markdownEscape(r.quote)} (SHA-256: ${r.sha256})`,
      )
      .join("\n") +
    "\n";
  const html =
    `<!doctype html>\n<html lang="${draft.language}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${htmlEscape(draft.title)}</title><style>body{max-width:780px;margin:48px auto;padding:0 24px;font:16px/1.7 system-ui;color:#172033}h1,h2{line-height:1.3}p{white-space:pre-wrap}aside{border-top:1px solid #ccd3db;margin-top:40px;padding-top:16px}small{overflow-wrap:anywhere}</style></head><body><h1>${htmlEscape(draft.title)}</h1>` +
    draft.sections
      .map(
        (s) =>
          `<section><h2>${htmlEscape(s.heading)}</h2><p>${htmlEscape(s.text)}</p>${s.citations.map((c) => `<a href="#${ref(c.blockId).id}">[${ref(c.blockId).id}]</a>`).join(" ")}</section>`,
      )
      .join("") +
    `<aside><h2>Sources</h2>` +
    references
      .map(
        (r) =>
          `<article id="${r.id}"><a href="./${r.file}#L${r.line}">${r.file}:${r.line}</a><blockquote>${htmlEscape(r.quote)}</blockquote><small>SHA-256: ${r.sha256}</small></article>`,
      )
      .join("") +
    "</aside></body></html>\n";
  const files: Record<string, string> = {
    "content.json": JSON.stringify({ ...draft, references }, null, 2) + "\n",
    "content.md": markdown,
    "content.html": html,
    "review.json": JSON.stringify(review, null, 2) + "\n",
  };
  for (const source of material.sources)
    files[`sources/${source.file}`] = source.content;
  files["manifest.json"] =
    JSON.stringify(
      {
        files: Object.entries(files).map(([file, content]) => ({
          file,
          sha256: digest(content),
          bytes: Buffer.byteLength(content),
        })),
      },
      null,
      2,
    ) + "\n";
  return files;
}
