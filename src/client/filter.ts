// Filter engine (FR-2). Runs on the device over the whole library, so any
// combination answers instantly. Dates are relative ("last 30 days") so saved
// filters stay current (FR-2.6).
import type { Concept, LibQ, Result } from "./types";

export type Cond =
  | { type: "subject"; ids: string[] }
  | { type: "concept"; ids: string[]; includeSub: boolean; minWeight: number }
  | { type: "difficulty"; codes: string[] }
  | { type: "never_attempted" }
  | { type: "attempt_count"; op: ">=" | "<=" | "="; value: number }
  | { type: "last_result"; results: Result[] }
  | { type: "last_attempted"; op: "more_than" | "within"; days: number }
  | { type: "personal_difficulty"; min: number; max: number } // percent 0..100
  | { type: "added"; op: "within" | "more_than"; days: number }
  | { type: "avg_time"; op: ">=" | "<="; seconds: number }
  | { type: "text"; query: string }
  | { type: "source_file"; names: string[] }
  | { type: "has_key"; value: boolean };

export interface Group { op: "and" | "or"; conds: Cond[] }
export interface FilterDef { v: 1; op: "and" | "or"; groups: Group[]; includeArchived?: boolean }

export const emptyFilter = (): FilterDef => ({ v: 1, op: "and", groups: [{ op: "and", conds: [] }] });

export const COND_LABELS: Record<Cond["type"], string> = {
  subject: "Subject",
  concept: "Concept",
  difficulty: "Difficulty label",
  never_attempted: "Never attempted",
  attempt_count: "Attempt count",
  last_result: "Last result",
  last_attempted: "Last attempted",
  personal_difficulty: "Personal difficulty",
  added: "Date added",
  avg_time: "Average time taken",
  text: "Text / ID search",
  source_file: "Source file",
  has_key: "Has answer key",
};

export function defaultCond(type: Cond["type"]): Cond {
  switch (type) {
    case "subject": return { type, ids: [] };
    case "concept": return { type, ids: [], includeSub: true, minWeight: 0 };
    case "difficulty": return { type, codes: [] };
    case "never_attempted": return { type };
    case "attempt_count": return { type, op: ">=", value: 1 };
    case "last_result": return { type, results: ["incorrect"] };
    case "last_attempted": return { type, op: "more_than", days: 14 };
    case "personal_difficulty": return { type, min: 50, max: 100 };
    case "added": return { type, op: "within", days: 30 };
    case "avg_time": return { type, op: ">=", seconds: 120 };
    case "text": return { type, query: "" };
    case "source_file": return { type, names: [] };
    case "has_key": return { type, value: true };
  }
}

export function descendants(concepts: Concept[], ids: string[]): Set<string> {
  const kids = new Map<string, string[]>();
  for (const c of concepts) if (c.parent_id) kids.set(c.parent_id, [...(kids.get(c.parent_id) ?? []), c.id]);
  const out = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(kids.get(id) ?? []));
  }
  return out;
}

const DAY = 86_400_000;

export function compile(def: FilterDef, concepts: Concept[], now = Date.now()): (q: LibQ) => boolean {
  const compileCond = (c: Cond): ((q: LibQ) => boolean) => {
    switch (c.type) {
      case "subject": {
        const s = new Set(c.ids);
        return (q) => s.size === 0 || (q.subject_id !== null && s.has(q.subject_id));
      }
      case "concept": {
        const s = c.includeSub ? descendants(concepts, c.ids) : new Set(c.ids);
        const min = c.minWeight || 0;
        return (q) => s.size === 0 || q.concepts.some(([id, w]) => s.has(id) && w >= min);
      }
      case "difficulty": {
        const s = new Set(c.codes);
        return (q) => s.size === 0 || (q.difficulty_code !== null && s.has(q.difficulty_code));
      }
      case "never_attempted":
        return (q) => !q.attempt_count;
      case "attempt_count":
        return (q) => {
          const n = q.attempt_count ?? 0;
          return c.op === ">=" ? n >= c.value : c.op === "<=" ? n <= c.value : n === c.value;
        };
      case "last_result": {
        const s = new Set(c.results);
        return (q) => q.last_result !== null && s.has(q.last_result);
      }
      case "last_attempted":
        return (q) => {
          if (q.last_attempted_at === null) return c.op === "more_than"; // never seen counts as "long ago"
          const age = now - q.last_attempted_at;
          return c.op === "more_than" ? age > c.days * DAY : age <= c.days * DAY;
        };
      case "personal_difficulty":
        return (q) => {
          const p = q.personal_difficulty_permille;
          if (p === null) return false;
          return p >= c.min * 10 && p <= c.max * 10;
        };
      case "added":
        return (q) => (c.op === "within" ? now - q.created_at <= c.days * DAY : now - q.created_at > c.days * DAY);
      case "avg_time":
        return (q) => {
          if (!q.attempt_count) return false;
          const avg = (q.total_time_seconds ?? 0) / q.attempt_count;
          return c.op === ">=" ? avg >= c.seconds : avg <= c.seconds;
        };
      case "text": {
        const terms = c.query.toLowerCase().split(/\s+/).filter(Boolean);
        return (q) => {
          if (!terms.length) return true;
          const hay = `${q.id} q${q.qno} ${q.file_name} ${q.plain_text}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        };
      }
      case "source_file": {
        const s = new Set(c.names);
        return (q) => s.size === 0 || s.has(q.file_name);
      }
      case "has_key":
        return (q) => !!q.has_key === c.value;
    }
  };
  const groups = def.groups.map((g) => {
    const fs = g.conds.map(compileCond);
    if (!fs.length) return () => true;
    return g.op === "and" ? (q: LibQ) => fs.every((f) => f(q)) : (q: LibQ) => fs.some((f) => f(q));
  });
  const live = (q: LibQ) => def.includeArchived || q.archived_at === null;
  if (!groups.length) return live;
  return def.op === "and"
    ? (q) => live(q) && groups.every((f) => f(q))
    : (q) => live(q) && groups.some((f) => f(q));
}

export function parseDef(s: string): FilterDef {
  try {
    const d = JSON.parse(s);
    if (d && d.v === 1 && Array.isArray(d.groups)) return d;
  } catch { /* fall through */ }
  return emptyFilter();
}
