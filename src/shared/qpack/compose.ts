// Builds what gets stored from a normalised question:
//   * the immutable content record (StoredQuestion → JSON file in R2),
//   * its fingerprint source (DR-2: content only — answers/solutions are editable metadata),
//   * the answer key used for automatic marking,
//   * one Markdown solution document (final answers + working, part by part),
//   * plain text for search.
import { escapeHtml } from "./normalize";
import { STORED_FORMAT, type Answer, type Content, type NQuestion, type Option, type Part, type QType, type Solution, type StoredQuestion } from "./types";

export type AnswerFormat = "none" | "mcq_single" | "mcq_multi" | "numeric" | "text";

export function answerFormatOf(type: QType): AnswerFormat {
  switch (type) {
    case "mcq_single": return "mcq_single";
    case "mcq_multi": return "mcq_multi";
    case "numeric": return "numeric";
    case "short_answer": return "text";
    default: return "none";
  }
}

export interface KeyOut {
  answer_type: "mcq_single" | "mcq_multi" | "numeric" | "text";
  mcq_correct?: string[];
  numeric_value?: number;
  numeric_tolerance?: number;
  text_value?: string;
  origin: "import" | "suggestion";
}

/** Answer key for automatic marking (top-level multiple choice / numeric; short answers are shown, not auto-marked). */
export function answerKeyOf(q: NQuestion): KeyOut | null {
  const a = q.answer;
  if (!a) return null;
  const origin = q.answerOrigin === "ai" ? "suggestion" : "import";
  if ((q.type === "mcq_single" || q.type === "mcq_multi") && a.kind === "mcq") return { answer_type: q.type, mcq_correct: a.labels, origin };
  if (q.type === "numeric" && a.kind === "numeric") return { answer_type: "numeric", numeric_value: a.value, numeric_tolerance: a.tolerance, origin };
  if (q.type === "short_answer" && a.kind === "text") return { answer_type: "text", text_value: a.accepted.join(" | "), origin };
  return null;
}

// ---------------------------------------------------------------- markdown helpers

export function htmlBlock(html: string): string {
  // An HTML block in Markdown ends at a blank line, so blank lines inside are removed.
  return `<div class="html-block">\n${html.replace(/\n\s*\n/g, "\n").trim()}\n</div>`;
}

export const mdOf = (c: Content): string => (c.md !== undefined ? c.md : htmlBlock(c.html ?? ""));

const indent = (s: string, n: number) => s.split("\n").map((l, i) => (i === 0 || !l ? l : " ".repeat(n) + l)).join("\n");

function optionText(options: Option[], label: string): string | null {
  const o = options.find((x) => x.label === label);
  if (!o) return null;
  const t = o.content.md ?? null;
  return t && t.length <= 80 && !t.includes("\n") ? t : null;
}

export function answerDisplay(a: Answer, options: Option[]): string {
  switch (a.kind) {
    case "mcq":
      return a.labels.map((l) => {
        const t = optionText(options, l);
        return t ? `${l} (${t})` : l;
      }).join(", ");
    case "numeric":
      return a.tolerance ? `${a.display} (± ${a.tolerance})` : a.display;
    case "text":
      return a.accepted.length > 1 ? `${a.accepted[0]} (also accepted: ${a.accepted.slice(1).join(", ")})` : a.accepted[0];
    case "content":
      return mdOf(a.content);
  }
}

function block(answer: Answer | null, options: Option[], sol: Solution | null): string[] {
  const out: string[] = [];
  // The source's own wording of the final answer ("28 students") wins over the bare key ("28").
  const ans = sol?.answer ? mdOf(sol.answer) : answer ? answerDisplay(answer, options) : null;
  if (ans) out.push(ans.includes("\n") ? `**Answer:**\n\n${ans}` : `**Answer:** ${ans}`);
  if (sol?.steps.length) out.push(sol.steps.map((s, i) => `${i + 1}. ${indent(mdOf(s), 3)}`).join("\n"));
  if (sol?.body) out.push(mdOf(sol.body));
  return out;
}

export interface ComposedSolution {
  format: "markdown" | "html";
  body: string;
  origin: "import" | "suggestion";
}

export function composeSolution(q: NQuestion): ComposedSolution | null {
  const sections: string[] = [];
  let ai = q.solution?.origin === "ai";
  // A solution that is only one HTML document is stored as HTML, untouched.
  if (q.type !== "multi_part" && !q.answer && q.solution && q.solution.body?.html !== undefined && !q.solution.steps.length && !q.solution.answer) {
    return { format: "html", body: q.solution.body.html, origin: ai ? "suggestion" : "import" };
  }
  if (q.type === "multi_part") {
    if (q.solution) sections.push(...block(q.answer, [], q.solution));
    else if (q.answer) sections.push(...block(q.answer, [], null));
    for (const p of q.parts) {
      if (!p.answer && !p.solution) continue;
      if (p.solution?.origin === "ai") ai = true;
      const lines = block(p.answer, p.options, p.solution);
      sections.push(`**(${p.label})** ${lines[0] ?? ""}`.trim() + (lines.length > 1 ? `\n\n${lines.slice(1).join("\n\n")}` : ""));
    }
  } else {
    sections.push(...block(q.answer, q.options, q.solution));
  }
  if (!sections.length) return null;
  return { format: "markdown", body: sections.join("\n\n"), origin: ai || (q.answer && q.answerOrigin === "ai") ? "suggestion" : "import" };
}

// ---------------------------------------------------------------- content walking & assets

const MD_IMG = /(!\[[^\]]*\]\(\s*<?)([^)\s>]+)(>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\))/g;
const HTML_SRC = /(\b(?:src|href|xlink:href)\s*=\s*["'])([^"']+)(["'])/gi;

const isLocalRef = (t: string) => !/^(data:|https?:|mailto:|#|\/\/|javascript:)/i.test(t) && t.trim() !== "";

export function refsInContent(c: Content | null): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.md !== undefined) {
    for (const m of c.md.matchAll(MD_IMG)) if (isLocalRef(m[2])) out.push(m[2]);
    for (const m of c.md.matchAll(HTML_SRC)) if (isLocalRef(m[2])) out.push(m[2]);
  } else if (c.html !== undefined) {
    for (const m of c.html.matchAll(HTML_SRC)) if (isLocalRef(m[2])) out.push(m[2]);
  }
  return out;
}

export function externalRefs(c: Content | null): string[] {
  if (!c) return [];
  const text = c.md ?? c.html ?? "";
  const out: string[] = [];
  for (const m of text.matchAll(MD_IMG)) if (/^https?:/i.test(m[2])) out.push(m[2]);
  for (const m of text.matchAll(/\b(?:src)\s*=\s*["'](https?:[^"']+)["']/gi)) out.push(m[1]);
  return out;
}

export function rewriteRefs(c: Content, map: (target: string) => string | null): Content {
  const swap = (_: string, a: string, t: string, b: string) => {
    if (!isLocalRef(t)) return a + t + b;
    const r = map(t);
    return a + (r ?? t) + b;
  };
  if (c.md !== undefined) return { md: c.md.replace(MD_IMG, swap).replace(HTML_SRC, swap) };
  return { html: (c.html ?? "").replace(HTML_SRC, swap) };
}

/** Apply fn to every Content inside a question (stem, options, parts, hints, answers, solutions). */
export function mapContents(q: NQuestion, fn: (c: Content) => Content): NQuestion {
  const f = (c: Content | null) => (c ? fn(c) : null);
  const opts = (os: Option[]) => os.map((o) => ({ label: o.label, content: fn(o.content) }));
  const ans = (a: Answer | null): Answer | null => (a && a.kind === "content" ? { kind: "content", content: fn(a.content) } : a);
  const sol = (s: Solution | null): Solution | null => (s ? { answer: f(s.answer), steps: s.steps.map(fn), body: f(s.body), origin: s.origin } : null);
  const part = (p: Part): Part => ({ ...p, stem: f(p.stem), options: opts(p.options), answer: ans(p.answer), solution: sol(p.solution), hints: p.hints.map(fn) });
  return { ...q, stem: f(q.stem), options: opts(q.options), answer: ans(q.answer), solution: sol(q.solution), hints: q.hints.map(fn), parts: q.parts.map(part) };
}

export function allContents(q: NQuestion): Content[] {
  const out: Content[] = [];
  mapContents(q, (c) => {
    out.push(c);
    return c;
  });
  return out;
}

// ---------------------------------------------------------------- stored record, fingerprint, text

export function storedQuestionOf(q: NQuestion, css: string | null): StoredQuestion {
  const usesHtml = allContents(q).some((c) => c.html !== undefined);
  return {
    schema: STORED_FORMAT,
    type: q.type,
    number: q.number,
    stem: q.stem,
    options: q.options,
    parts: q.parts.map((p) => ({ label: p.label, type: p.type, stem: p.stem, options: p.options, marks: p.marks, hints: p.hints })),
    hints: q.hints,
    css: usesHtml ? css : null,
    source: q.source ?? null,
    extra: q.extra,
  };
}

/** Stable JSON: object keys sorted, so the same content always gives the same text. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

const normText = (c: Content | null) => (c ? (c.md !== undefined ? { md: c.md.normalize("NFC").replace(/\s+/g, " ").trim() } : { html: (c.html ?? "").normalize("NFC").replace(/\s+/g, " ").trim() }) : null);

/** What identifies the question's content (DR-2). Numbering, source, answers and solutions are not part of it. */
export function fingerprintSource(s: StoredQuestion): string {
  return canonicalJson({
    v: 1,
    type: s.type,
    stem: normText(s.stem),
    options: s.options.map((o) => ({ l: o.label, c: normText(o.content) })),
    parts: s.parts.map((p) => ({ l: p.label, t: p.type, s: normText(p.stem), o: p.options.map((o) => ({ l: o.label, c: normText(o.content) })), h: p.hints.map(normText) })),
    hints: s.hints.map(normText),
    css: s.css ? s.css.replace(/\s+/g, " ").trim() : null,
  });
}

export function mdToPlain(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1/$2")
    .replace(/\\(times|cdot)/g, "×")
    .replace(/\\(div)/g, "÷")
    .replace(/\\[,;:! ]/g, " ")
    .replace(/\\text\{([^{}]*)\}/g, "$1")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/[$*_`#>{}|\\]/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const plainOf = (c: Content | null) => (c ? mdToPlain(c.md ?? c.html ?? "") : "");

export function plainTextOf(q: NQuestion): string {
  const bits = [plainOf(q.stem), ...q.options.map((o) => `${o.label}. ${plainOf(o.content)}`)];
  for (const p of q.parts) bits.push(`(${p.label}) ${plainOf(p.stem)}`, ...p.options.map((o) => `${o.label}. ${plainOf(o.content)}`));
  return bits.filter(Boolean).join(" ").slice(0, 4000);
}

export { escapeHtml };
