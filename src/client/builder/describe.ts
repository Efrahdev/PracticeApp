// Words for everything the builder shows: labels, relative times, and plain-English
// summaries of rules (used in the builder and on a saved paper's page).
import { COND_LABELS, type Cond, type FilterDef } from "../filter";
import type { Boot, LibQ } from "../types";
import { conceptPathOf } from "./engine";
import type { Ctx } from "./pool";
import { DIMS, hasConditions, NONE, OTHER, rangeOn, type Blueprint, type DimKey, type Range, type Recency, type ResultBucket, type Unit } from "./spec";

const DAY = 86_400_000;

export const FORMAT_LABEL: Record<string, string> = {
  none: "Self-marked", mcq_single: "Multiple choice", mcq_multi: "Multiple choice (several)", numeric: "Number", text: "Text",
};
export const FORMAT_SHORT: Record<string, string> = {
  none: "Self-marked", mcq_single: "MCQ", mcq_multi: "MCQ (multi)", numeric: "Number", text: "Text",
};
export const RESULT_LABEL: Record<ResultBucket, string> = {
  never: "Not attempted", incorrect: "Incorrect", partial: "Partly right", correct: "Correct", ungraded: "Not graded",
};
export const DIM_LABEL: Record<DimKey, string> = {
  subject: "Subject", concept: "Concept", difficulty: "Difficulty", result: "Last result", format: "Answer type",
};
export const DIM_PLURAL: Record<DimKey, string> = {
  subject: "subjects", concept: "concepts", difficulty: "difficulty labels", result: "results", format: "answer types",
};
export const ORDER_LABEL: Record<Blueprint["order"], string> = {
  picked: "As picked (random)", easy_first: "Easiest first", hard_first: "Hardest first", subject: "Grouped by subject and concept", manual: "My own order",
};

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
export const unitWord = (n: number, u: Unit) => (n === 1 ? u.slice(0, -1) : u);

export function ago(ms: number | null, now = Date.now()): string {
  if (ms === null) return "never";
  const d = Math.floor((now - ms) / DAY);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.floor(d / 7)} weeks ago`;
  if (d < 365) return `${Math.floor(d / 30)} months ago`;
  return plural(Math.floor(d / 365), "year") + " ago";
}

export function difficultyTone(ctx: Ctx, code: string | null): string {
  if (!code) return "t-none";
  const r = ctx.rank.get(code);
  if (r === undefined) return "t-none";
  const n = ctx.rank.size;
  // Spread the authored labels over four tones, easiest → hardest.
  const i = n <= 1 ? 0 : Math.round((r / (n - 1)) * 3);
  return `t-${i}`;
}

/** Subjects keep the same colour everywhere: slot by their place in the subject list (the first eight get a hue, the rest share grey). */
export function subjectSlot(ctx: Ctx, subjectId: string | null): string {
  if (!subjectId) return "x";
  const i = ctx.tree.filter((n) => n.kind === "subject").findIndex((n) => n.subjectId === subjectId);
  return i >= 0 && i < 8 ? String(i + 1) : "x";
}

export function valueLabel(dim: DimKey, v: string, ctx: Ctx): string {
  if (v === OTHER) return "Everything else";
  switch (dim) {
    case "subject": return v === NONE ? "No subject" : ctx.subjectName.get(v) ?? "Unknown subject";
    case "concept": return conceptPathOf(ctx, v);
    case "difficulty": return v === NONE ? "No label" : ctx.boot.difficulties.find((d) => d.code === v)?.label ?? v;
    case "result": return RESULT_LABEL[v as ResultBucket] ?? v;
    case "format": return FORMAT_LABEL[v] ?? v;
  }
}

export function rangeText(r: Range, unit = ""): string {
  const u = unit ? ` ${unit}` : "";
  if (r.min !== null && r.max !== null) return r.min === r.max ? `${r.min}${u}` : `${r.min}–${r.max}${u}`;
  if (r.min !== null) return `at least ${r.min}${u}`;
  if (r.max !== null) return `at most ${r.max}${u}`;
  return "any";
}

export function recencyText(r: Recency): string {
  switch (r.mode) {
    case "any": return "any time";
    case "never": return "never attempted";
    case "more_than": return `more than ${r.n} ${unitWord(r.n, r.unit)} ago${r.includeNever ? ", or never" : ""}`;
    case "within": return `within the last ${r.n} ${unitWord(r.n, r.unit)}`;
    case "between": return `between ${Math.min(r.n, r.m)} and ${Math.max(r.n, r.m)} ${r.unit} ago`;
  }
}

const list = (xs: string[], max = 4) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} +${xs.length - max} more`);

export function describeCond(c: Cond, boot: Boot, ctx: Ctx | null): string {
  const subj = (id: string) => boot.subjects.find((s) => s.id === id)?.name ?? "?";
  const conc = (id: string) => (ctx ? conceptPathOf(ctx, id) : boot.concepts.find((x) => x.id === id)?.name ?? "?");
  const diff = (code: string) => boot.difficulties.find((d) => d.code === code)?.label ?? code;
  switch (c.type) {
    case "subject": return c.ids.length ? `Subject: ${list(c.ids.map(subj))}` : "Subject: any";
    case "concept":
      return c.ids.length
        ? `Concept: ${list(c.ids.map(conc), 3)}${c.includeSub ? " (with sub-concepts)" : ""}${c.minWeight ? `, weight ≥ ${c.minWeight}` : ""}`
        : "Concept: any";
    case "difficulty": return c.codes.length ? `Difficulty: ${list(c.codes.map(diff))}` : "Difficulty: any";
    case "never_attempted": return "Never attempted";
    case "attempt_count": return `Attempts ${c.op === ">=" ? "at least" : c.op === "<=" ? "at most" : "exactly"} ${c.value}`;
    case "last_result": return `Last result: ${c.results.join(", ") || "any"}`;
    case "last_attempted": return `Last attempted ${c.op === "more_than" ? `more than ${c.days} days ago` : `within the last ${c.days} days`}`;
    case "personal_difficulty": return `Personal difficulty ${c.min}–${c.max}%`;
    case "added": return `Added ${c.op === "within" ? `within the last ${c.days} days` : `more than ${c.days} days ago`}`;
    case "avg_time": return `Average time ${c.op === ">=" ? "at least" : "at most"} ${c.seconds} s`;
    case "text": return c.query.trim() ? `Text contains “${c.query.trim()}”` : "Text: any";
    case "source_file": return c.names.length ? `Source file: ${list(c.names, 2)}` : "Source file: any";
    case "has_key": return c.value ? "Has an answer key" : "No answer key";
    case "has_solution": return c.value === "none" ? "No solution" : c.value === "unverified" ? "AI-written solution, not verified" : "Has a solution";
    case "import": {
      const label = (id: string) => boot.imports.find((im) => im.id === id)?.label || boot.imports.find((im) => im.id === id)?.file_name || "?";
      return c.ids.length ? `Import: ${list(c.ids.map(label), 2)}` : "Import: any";
    }
    case "field": {
      const f = boot.fields.find((x) => x.id === c.field_id);
      if (!f) return COND_LABELS.field;
      const op = { has_value: "has a value", no_value: "has no value", contains: `contains “${c.value}”`, equals: `is “${c.value}”`, ">=": `≥ ${c.value}`, "<=": `≤ ${c.value}`, is_true: "is yes", is_false: "is no", on_or_after: `on or after ${c.value}`, on_or_before: `on or before ${c.value}` }[c.op];
      return `${f.name} ${op}`;
    }
  }
}

/** One line per group, e.g. ["Subject: Maths and Never attempted", "OR Difficulty: Hard"]. */
export function describeFilter(def: FilterDef, boot: Boot, ctx: Ctx | null): string[] {
  const groups = def.groups.filter((g) => g.conds.length);
  return groups.map((g, i) => `${i ? `${def.op.toUpperCase()} ` : ""}${g.conds.map((c) => describeCond(c, boot, ctx)).join(` ${g.op} `)}`);
}

export interface RuleLine { label: string; value: string }

/** Plain-English summary of how a paper was built (shown on the paper's page). */
export function describeBlueprint(bp: Blueprint, boot: Boot, ctx: Ctx, lib: LibQ[]): RuleLine[] {
  const out: RuleLine[] = [];
  const p = bp.pool;
  if (p.tree) {
    const picked = p.tree.filter((k) => !k.startsWith("u:")).map((k) => conceptPathOf(ctx, k));
    const untagged = p.tree.filter((k) => k.startsWith("u:")).map((k) => (k === `u:${NONE}` ? "no subject" : `${ctx.subjectName.get(k.slice(2)) ?? "?"} (not tagged)`));
    out.push({ label: "Subjects & concepts", value: list([...picked, ...untagged], 6) || "none" });
  }
  if (p.difficulty) out.push({ label: "Difficulty", value: list(p.difficulty.map((d) => valueLabel("difficulty", d, ctx))) || "none" });
  if (p.attempted !== "any") out.push({ label: "Attempted", value: p.attempted === "yes" ? "attempted before" : "never attempted" });
  if (p.recency.mode !== "any") out.push({ label: "Last attempted", value: recencyText(p.recency) });
  if (rangeOn(p.attempts)) out.push({ label: "Attempts", value: rangeText(p.attempts) });
  if (p.results.length) out.push({ label: "Last result", value: p.results.map((r) => RESULT_LABEL[r]).join(", ") });
  if (rangeOn(p.avgMinutes)) out.push({ label: "Average time", value: rangeText(p.avgMinutes, "min") });
  if (rangeOn(p.personal)) out.push({ label: "Personal difficulty", value: rangeText(p.personal, "%") });
  if (p.formats.length) out.push({ label: "Answer type", value: p.formats.map((f) => FORMAT_LABEL[f] ?? f).join(", ") });
  if (rangeOn(p.marks)) out.push({ label: "Marks", value: rangeText(p.marks) });
  if (p.solution !== "any") out.push({ label: "Solution", value: { has: "has a solution", verified: "verified solution", ai: "AI-written, not verified", none: "no solution" }[p.solution] });
  if (p.key !== "any") out.push({ label: "Answer key", value: p.key === "has" ? "has a key" : "no key" });
  if (p.imports.length) out.push({ label: "Imports", value: list(p.imports.map((id) => ctx.importLabel.get(id) ?? "?"), 3) });
  if (p.added.mode !== "any") out.push({ label: "Added", value: `${p.added.mode === "within" ? "within the last" : "more than"} ${p.added.n} ${unitWord(p.added.n, p.added.unit)}${p.added.mode === "more_than" ? " ago" : ""}` });
  if (p.text.trim()) out.push({ label: "Text", value: `“${p.text.trim()}”` });
  if (p.includeArchived) out.push({ label: "Archived", value: "included" });
  if (hasConditions(p.advanced)) out.push({ label: "Conditions", value: describeFilter(p.advanced, boot, ctx).join(" ") });
  for (const d of DIMS) {
    const s = bp.shares[d];
    const vals = Object.entries(s.values).filter(([, v]) => v > 0);
    if (!s.on || !vals.length) continue;
    out.push({ label: `Mix by ${DIM_LABEL[d].toLowerCase()}`, value: vals.map(([k, v]) => `${valueLabel(d, k, ctx)} ${v}${s.unit === "percent" ? "%" : ""}`).join(", ") });
  }
  const fav = [bp.favourWrong && "got wrong", bp.favourStale && "not seen recently", bp.favourWeak && "weak concepts"].filter(Boolean);
  if (fav.length) out.push({ label: "Favoured", value: fav.join(", ") });
  out.push({ label: "Order", value: ORDER_LABEL[bp.order] });
  const byId = new Map(lib.map((q) => [q.id, q]));
  if (bp.pinned.length) out.push({ label: "Pinned", value: list(bp.pinned.map((id) => (byId.get(id) ? `Q${byId.get(id)!.qno}` : "?")), 8) });
  if (bp.excluded.length) out.push({ label: "Removed by hand", value: plural(bp.excluded.length, "question") });
  return out;
}
