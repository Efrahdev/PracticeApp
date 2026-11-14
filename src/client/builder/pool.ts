// Which questions may go into a paper (the pool), plus live counts for every choice
// in the builder. Counts are "faceted": each list counts what you would get if you
// ticked that item, given all your OTHER rules — like a shop's filter sidebar.
// Runs on the device over the whole library (~1,000 rows) in a few milliseconds.
import { compile } from "../filter";
import type { Boot, Concept, LibQ } from "../types";
import { hasConditions, NONE, rangeOn, resultBucket, UNIT_DAYS, type PoolSpec, type Range } from "./spec";

const DAY = 86_400_000;

export interface TreeNode {
  key: string; // concept id | "u:<subject>" (not tagged) | "s:<subject>" (subject row)
  kind: "subject" | "concept" | "untagged";
  label: string;
  subjectId: string;
  depth: number;
  children: TreeNode[];
  keys: string[]; // every tickable key at or below this node
}

export interface Ctx {
  boot: Boot;
  concept: Map<string, Concept>;
  /** live concept id → [itself, parent, grandparent, …] */
  chain: Map<string, string[]>;
  /** question id → its tags on concepts shown in the tree (merges followed), strongest weight kept */
  tags: Map<string, [string, number][]>;
  hay: Map<string, string>;
  tree: TreeNode[];
  node: Map<string, TreeNode>;
  allKeys: string[];
  rank: Map<string, number>; // difficulty code → position (0 = easiest)
  subjectName: Map<string, string>;
  importLabel: Map<string, string>;
}

export const untaggedKey = (subjectId: string | null) => `u:${subjectId ?? NONE}`;

export function makeCtx(boot: Boot, lib: LibQ[]): Ctx {
  const concept = new Map(boot.concepts.map((c) => [c.id, c]));
  const liveId = (id: string): string | null => {
    let c = concept.get(id);
    for (let guard = 0; c && c.archived_at && guard < 20; guard++) c = c.merged_into_id ? concept.get(c.merged_into_id) : undefined;
    return c && !c.archived_at ? c.id : null;
  };
  const live = boot.concepts.filter((c) => !c.archived_at);
  const kids = new Map<string, Concept[]>();
  for (const c of live) {
    const parent = c.parent_id && concept.get(c.parent_id) && !concept.get(c.parent_id)!.archived_at ? c.parent_id : null;
    const k = parent ?? `root:${c.subject_id}`;
    kids.set(k, [...(kids.get(k) ?? []), c]);
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

  const subjectsUsed = new Set(lib.map((q) => q.subject_id).filter((s): s is string => !!s));
  const subjects = boot.subjects.filter((s) => !s.archived_at || subjectsUsed.has(s.id) || (kids.get(`root:${s.id}`)?.length ?? 0) > 0).sort(byName);
  const subjectName = new Map(boot.subjects.map((s) => [s.id, s.archived_at ? `${s.name} (archived)` : s.name]));

  const node = new Map<string, TreeNode>();
  const conceptNode = (c: Concept, depth: number, seen: Set<string>): TreeNode => {
    seen.add(c.id);
    const children = (kids.get(c.id) ?? []).filter((k) => !seen.has(k.id)).sort(byName).map((k) => conceptNode(k, depth + 1, seen));
    const n: TreeNode = { key: c.id, kind: "concept", label: c.name, subjectId: c.subject_id, depth, children, keys: [c.id, ...children.flatMap((x) => x.keys)] };
    node.set(n.key, n);
    return n;
  };
  const tree: TreeNode[] = [];
  for (const s of subjects) {
    const seen = new Set<string>();
    const children = (kids.get(`root:${s.id}`) ?? []).sort(byName).map((c) => conceptNode(c, 1, seen));
    const u: TreeNode = { key: untaggedKey(s.id), kind: "untagged", label: "Not tagged with a concept", subjectId: s.id, depth: 1, children: [], keys: [untaggedKey(s.id)] };
    node.set(u.key, u);
    children.push(u);
    const n: TreeNode = { key: `s:${s.id}`, kind: "subject", label: subjectName.get(s.id)!, subjectId: s.id, depth: 0, children, keys: children.flatMap((x) => x.keys) };
    node.set(n.key, n);
    tree.push(n);
  }
  if (lib.some((q) => q.subject_id === null || !node.has(`s:${q.subject_id}`))) {
    const u: TreeNode = { key: untaggedKey(null), kind: "untagged", label: "No subject", subjectId: NONE, depth: 0, children: [], keys: [untaggedKey(null)] };
    node.set(u.key, u);
    tree.push(u);
  }
  const shown = new Set<string>();
  for (const n of node.values()) if (n.kind === "concept") shown.add(n.key);

  const chain = new Map<string, string[]>();
  for (const id of shown) {
    const out: string[] = [];
    let c = concept.get(id);
    for (let guard = 0; c && guard < 30 && shown.has(c.id); guard++) {
      out.push(c.id);
      c = c.parent_id ? concept.get(c.parent_id) : undefined;
    }
    chain.set(id, out);
  }

  const tags = new Map<string, [string, number][]>();
  const hay = new Map<string, string>();
  for (const q of lib) {
    const m = new Map<string, number>();
    for (const [cid, w] of q.concepts) {
      const id = liveId(cid);
      if (id && shown.has(id)) m.set(id, Math.max(m.get(id) ?? 0, w));
    }
    tags.set(q.id, [...m]);
    hay.set(q.id, `${q.id} q${q.qno} ${q.file_name} ${q.plain_text}`.toLowerCase());
  }

  const rank = new Map([...boot.difficulties].sort((a, b) => a.sort_rank - b.sort_rank).map((d, i) => [d.code, i]));
  const importLabel = new Map((boot.imports ?? []).map((im) => [im.id, im.label || im.file_name]));
  return { boot, concept, chain, tags, hay, tree, node, allKeys: tree.flatMap((n) => n.keys), rank, subjectName, importLabel };
}

/** Ticks a node's whole subtree, or unticks it when it is already fully ticked. Everything ticked = null (no limit). */
export function treeToggle(ctx: Ctx, sel: string[] | null, n: TreeNode): string[] | null {
  const cur = new Set(sel ?? ctx.allKeys);
  const all = n.keys.every((k) => cur.has(k));
  for (const k of n.keys) (all ? cur.delete(k) : cur.add(k));
  return ctx.allKeys.every((k) => cur.has(k)) ? null : ctx.allKeys.filter((k) => cur.has(k));
}

export type TriState = "on" | "off" | "some";
export function treeState(sel: Set<string> | null, n: TreeNode): TriState {
  if (!sel) return "on";
  let on = 0;
  for (const k of n.keys) if (sel.has(k)) on++;
  return on === 0 ? "off" : on === n.keys.length ? "on" : "some";
}

// ------------------------------------------------------------------ rules

type Facet =
  | "archived" | "advanced" | "text" | "tree" | "difficulty" | "recency" | "attempts" | "results"
  | "time" | "personal" | "formats" | "marks" | "solution" | "key" | "imports" | "added";

const inRange = (v: number, r: Range) => (r.min === null || v >= r.min) && (r.max === null || v <= r.max);

export function rules(p: PoolSpec, ctx: Ctx, now: number): [Facet, (q: LibQ) => boolean][] {
  const out: [Facet, (q: LibQ) => boolean][] = [];
  if (!p.includeArchived) out.push(["archived", (q) => q.archived_at === null]);
  if (hasConditions(p.advanced)) {
    const f = compile({ ...p.advanced, includeArchived: true }, ctx.boot.concepts, now);
    out.push(["advanced", f]);
  }
  const terms = p.text.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) out.push(["text", (q) => { const h = ctx.hay.get(q.id) ?? ""; return terms.every((t) => h.includes(t)); }]);
  if (p.tree) {
    const sel = new Set(p.tree);
    out.push(["tree", (q) => {
      const t = ctx.tags.get(q.id) ?? [];
      return t.length ? t.some(([c]) => sel.has(c)) : sel.has(untaggedKey(q.subject_id && ctx.node.has(`s:${q.subject_id}`) ? q.subject_id : null));
    }]);
  }
  if (p.difficulty) {
    const s = new Set(p.difficulty);
    out.push(["difficulty", (q) => s.has(q.difficulty_code ?? NONE)]);
  }
  const r = p.recency;
  if (r.mode !== "any") {
    const d = UNIT_DAYS[r.unit] * DAY;
    if (r.mode === "never") out.push(["recency", (q) => q.last_attempted_at === null]);
    else if (r.mode === "more_than") out.push(["recency", (q) => (q.last_attempted_at === null ? r.includeNever : now - q.last_attempted_at > r.n * d)]);
    else if (r.mode === "within") out.push(["recency", (q) => q.last_attempted_at !== null && now - q.last_attempted_at <= r.n * d]);
    else {
      const lo = Math.min(r.n, r.m) * d, hi = Math.max(r.n, r.m) * d;
      out.push(["recency", (q) => q.last_attempted_at !== null && now - q.last_attempted_at >= lo && now - q.last_attempted_at <= hi]);
    }
  }
  if (rangeOn(p.attempts)) out.push(["attempts", (q) => inRange(q.attempt_count ?? 0, p.attempts)]);
  if (p.results.length) {
    const s = new Set<string>(p.results);
    out.push(["results", (q) => s.has(resultBucket(q))]);
  }
  if (rangeOn(p.avgMinutes)) out.push(["time", (q) => !!q.attempt_count && inRange((q.total_time_seconds ?? 0) / q.attempt_count / 60, p.avgMinutes)]);
  if (rangeOn(p.personal)) out.push(["personal", (q) => q.personal_difficulty_permille !== null && inRange(q.personal_difficulty_permille / 10, p.personal)]);
  if (p.formats.length) {
    const s = new Set(p.formats);
    out.push(["formats", (q) => s.has(q.answer_format)]);
  }
  if (rangeOn(p.marks)) out.push(["marks", (q) => q.marks !== null && inRange(q.marks, p.marks)]);
  if (p.solution !== "any") {
    const s = p.solution;
    out.push(["solution", (q) => (s === "has" ? !!q.has_solution : s === "verified" ? q.has_solution === 1 : s === "ai" ? q.has_solution === 2 : !q.has_solution)]);
  }
  if (p.key !== "any") out.push(["key", (q) => (p.key === "has" ? !!q.has_key : !q.has_key)]);
  if (p.imports.length) {
    const s = new Set(p.imports);
    out.push(["imports", (q) => q.batches.some((b) => s.has(b))]);
  }
  if (p.added.mode !== "any") {
    const span = p.added.n * UNIT_DAYS[p.added.unit] * DAY;
    out.push(["added", (q) => (p.added.mode === "within" ? now - q.created_at <= span : now - q.created_at > span)]);
  }
  return out;
}

export interface PoolEval {
  pool: LibQ[];
  libraryCount: number; // questions that could ever be used (archived only when allowed)
  active: number; // how many rules narrow the pool
  activeFacets: Set<string>;
  counts: {
    tree: Map<string, number>;
    difficulty: Map<string, number>;
    results: Map<string, number>;
    formats: Map<string, number>;
    imports: Map<string, number>;
    solution: Map<string, number>;
    key: Map<string, number>;
  };
}

/** Tree nodes a question counts towards: its tagged concepts and their parents, its subjects, or its "not tagged" bucket. */
export function treeKeysOf(q: LibQ, ctx: Ctx): Set<string> {
  const out = new Set<string>();
  const t = ctx.tags.get(q.id) ?? [];
  if (!t.length) {
    const sid = q.subject_id && ctx.node.has(`s:${q.subject_id}`) ? q.subject_id : null;
    out.add(untaggedKey(sid));
    if (sid) out.add(`s:${sid}`);
    return out;
  }
  for (const [c] of t) {
    for (const id of ctx.chain.get(c) ?? []) out.add(id);
    const sid = ctx.concept.get(c)?.subject_id;
    if (sid) out.add(`s:${sid}`);
  }
  return out;
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

export function evaluatePool(lib: LibQ[], ctx: Ctx, p: PoolSpec, now: number): PoolEval {
  const rs = rules(p, ctx, now);
  const counts: PoolEval["counts"] = {
    tree: new Map(), difficulty: new Map(), results: new Map(), formats: new Map(), imports: new Map(), solution: new Map(), key: new Map(),
  };
  const count = (q: LibQ, only: Facet | null) => {
    if (!only || only === "tree") for (const k of treeKeysOf(q, ctx)) bump(counts.tree, k);
    if (!only || only === "difficulty") bump(counts.difficulty, q.difficulty_code ?? NONE);
    if (!only || only === "results") bump(counts.results, resultBucket(q));
    if (!only || only === "formats") bump(counts.formats, q.answer_format);
    if (!only || only === "imports") for (const b of new Set(q.batches)) bump(counts.imports, b);
    if (!only || only === "solution") {
      if (q.has_solution) bump(counts.solution, "has");
      bump(counts.solution, q.has_solution === 1 ? "verified" : q.has_solution === 2 ? "ai" : "none");
    }
    if (!only || only === "key") bump(counts.key, q.has_key ? "has" : "none");
  };
  const pool: LibQ[] = [];
  let libraryCount = 0;
  for (const q of lib) {
    if (p.includeArchived || q.archived_at === null) libraryCount++;
    let fails = 0;
    let failed: Facet | null = null;
    for (const [f, pass] of rs) {
      if (!pass(q)) {
        fails++;
        failed = f;
        if (fails > 1) break;
      }
    }
    if (fails === 0) {
      pool.push(q);
      count(q, null);
    } else if (fails === 1 && failed !== "archived") count(q, failed);
  }
  const activeFacets = new Set<string>(rs.map(([f]) => f).filter((f) => f !== "archived"));
  return { pool, libraryCount, active: activeFacets.size, activeFacets, counts };
}

// ------------------------------------------------------------------ breakdowns (for the mix editor and the summary)

export interface Breakdown {
  subject: Map<string, number>;
  concept: Map<string, number>; // aggregated: a parent counts its sub-concepts' questions (once each)
  difficulty: Map<string, number>;
  result: Map<string, number>;
  format: Map<string, number>;
}

export function breakdown(qs: LibQ[], ctx: Ctx): Breakdown {
  const b: Breakdown = { subject: new Map(), concept: new Map(), difficulty: new Map(), result: new Map(), format: new Map() };
  for (const q of qs) {
    bump(b.subject, q.subject_id ?? NONE);
    bump(b.difficulty, q.difficulty_code ?? NONE);
    bump(b.result, resultBucket(q));
    bump(b.format, q.answer_format);
    const seen = new Set<string>();
    for (const [c] of ctx.tags.get(q.id) ?? []) for (const id of ctx.chain.get(c) ?? []) seen.add(id);
    for (const id of seen) bump(b.concept, id);
  }
  return b;
}
