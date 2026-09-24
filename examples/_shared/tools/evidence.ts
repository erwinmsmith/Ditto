import { createHash } from "node:crypto";
import type { JsonObject } from "@codesoul-co/ditto/contracts";
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export const json = (v: unknown): JsonObject =>
  JSON.parse(JSON.stringify(v)) as JsonObject;
export function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Expected object");
  return v as Record<string, unknown>;
}
export function text(v: unknown, max = 1000): string {
  if (typeof v !== "string" || !v.trim() || v.length > max || v.includes("\0"))
    throw new Error("Invalid text");
  return v;
}
export function strings(v: unknown, max = 12): string[] {
  if (!Array.isArray(v) || v.length > max) throw new Error("Invalid list");
  return v.map((x) => text(x));
}
export function identifier(v: unknown): string {
  const s = text(v, 80);
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) throw new Error("Invalid identifier");
  return s;
}
export interface Plan {
  intent: string;
  queries: string[];
  facets: string[];
  clarification: string | null;
}
export function plan(v: unknown): Plan {
  const p = object(v),
    queries = strings(p.queries, 3).map((q) => text(q, 100)),
    facets = strings(p.facets, 5);
  if (p.clarification !== null && typeof p.clarification !== "string")
    throw new Error("Invalid clarification");
  if (
    p.clarification === null &&
    (!queries.length ||
      queries.some((q) => !tokens(q).length) ||
      !facets.length)
  )
    throw new Error("Missing query or facets");
  return {
    intent: text(p.intent, 300),
    queries: [...new Set(queries)],
    facets,
    clarification: p.clarification === null ? null : text(p.clarification, 500),
  };
}
export interface Selection {
  selectedIds: string[];
  missing: string[];
  conflicts: { sourceIds: string[]; description: string }[];
}
export function selection(
  v: unknown,
  pool: readonly { id: string }[],
): Selection {
  const s = object(v),
    selectedIds = strings(s.selectedIds, 8);
  if (
    new Set(selectedIds).size !== selectedIds.length ||
    selectedIds.some((id) => !pool.some((c) => c.id === id))
  )
    throw new Error("Invalid selection");
  if (!Array.isArray(s.conflicts) || s.conflicts.length > 5)
    throw new Error("Invalid conflicts");
  const conflicts = s.conflicts.map((x) => {
    const c = object(x),
      sourceIds = strings(c.sourceIds, 8);
    if (
      new Set(sourceIds).size < 2 ||
      sourceIds.some((id) => !selectedIds.includes(id))
    )
      throw new Error("Conflict needs two selected chunks");
    return { sourceIds, description: text(c.description, 500) };
  });
  return { selectedIds, missing: strings(s.missing, 5), conflicts };
}
export interface Claim {
  text: string;
  citations: { chunkId: string; quote: string }[];
}
export interface Answer {
  status:
    | "answered"
    | "insufficient-evidence"
    | "conflicting-evidence"
    | "needs-clarification";
  claims: Claim[];
  limitations: string[];
}
export function answer(
  v: unknown,
  evidence: readonly { id: string; text: string }[],
  selected: Selection,
): Answer {
  const a = object(v);
  if (
    ![
      "answered",
      "insufficient-evidence",
      "conflicting-evidence",
      "needs-clarification",
    ].includes(String(a.status)) ||
    !Array.isArray(a.claims) ||
    a.claims.length > 12
  )
    throw new Error("Invalid answer");
  const claims = a.claims.map((raw) => {
    const c = object(raw);
    if (
      !Array.isArray(c.citations) ||
      !c.citations.length ||
      c.citations.length > 8
    )
      throw new Error("Every claim needs citations");
    return {
      text: text(c.text, 800),
      citations: c.citations.map((raw) => {
        const cite = object(raw),
          chunkId = text(cite.chunkId, 80),
          quote = text(cite.quote, 1800),
          chunk = evidence.find((e) => e.id === chunkId);
        if (
          !chunk ||
          !selected.selectedIds.includes(chunkId) ||
          quote.trim().length < 4 ||
          !chunk.text.includes(quote)
        )
          throw new Error("Unsupported citation");
        return { chunkId, quote };
      }),
    };
  });
  const limitations = strings(a.limitations, 8);
  if (evidence.length) {
    const expected = selected.conflicts.length
      ? "conflicting-evidence"
      : selected.missing.length
        ? "insufficient-evidence"
        : "answered";
    if (a.status !== expected)
      throw new Error(`Answer status must match selection: ${expected}`);
  }
  if (
    a.status === "answered" &&
    (!claims.length || selected.missing.length || selected.conflicts.length)
  )
    throw new Error(
      "Incomplete or conflicting evidence cannot be answered conclusively",
    );
  if (selected.conflicts.length && a.status !== "conflicting-evidence")
    throw new Error("Conflict must be disclosed");
  if (a.status === "conflicting-evidence") {
    const cited = new Set(
      claims.flatMap((c) => c.citations.map((x) => x.chunkId)),
    );
    if (
      !selected.conflicts.length ||
      selected.conflicts.some((c) => c.sourceIds.some((id) => !cited.has(id)))
    )
      throw new Error("Cite both sides of every conflict");
  }
  if (a.status !== "answered" && !limitations.length)
    throw new Error("Explain unresolved requirements");
  return { status: a.status as Answer["status"], claims, limitations };
}
export function verify(v: unknown, count: number) {
  const o = object(v);
  if (
    !Array.isArray(o.claims) ||
    o.claims.length !== count ||
    o.complete !== true
  )
    throw new Error("Grounding check failed");
  const seen = new Set<number>();
  for (const raw of o.claims) {
    const c = object(raw);
    if (
      !Number.isSafeInteger(c.index) ||
      Number(c.index) < 0 ||
      Number(c.index) >= count ||
      seen.has(Number(c.index)) ||
      c.supported !== true
    )
      throw new Error("Grounding check failed");
    seen.add(Number(c.index));
  }
}

// CJK bigrams retain short Chinese search terms; Latin words remain whole FTS tokens.
export function tokens(s: string): string[] {
  return [
    ...new Set(
      (s.toLowerCase().match(/[a-z0-9_-]+|[\p{Script=Han}]+/gu) ?? []).flatMap(
        (word) =>
          /\p{Script=Han}/u.test(word)
            ? word.length === 1
              ? [word]
              : Array.from({ length: word.length - 1 }, (_, i) =>
                  word.slice(i, i + 2),
                )
            : [word],
      ),
    ),
  ];
}
