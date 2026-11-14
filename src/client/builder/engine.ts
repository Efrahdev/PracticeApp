// Paper generator v2. Same blueprint + same seed + same library = same paper (FR-3.5).
//
// 1. Each question's random number comes from (seed, question id), not from a running
//    sequence, so ticking a box or replacing one question never reshuffles the others.
// 2. "Favour" settings raise a question's weight; picking is weighted sampling without
//    replacement (Efraimidis–Spirakis: key = ln(u) / weight, highest key first).
// 3. Each active mix turns its shares into exact whole-number targets (largest
//    remainder). Questions are taken in priority order, skipping any that would
//    overfill a target while a better-fitting one exists; a swap pass then repairs what
//    the first pass could not, as far as the pool allows. Whatever is still off target
//    is reported, never hidden.
// 4. Pinned questions are always in; removed ones never are.
import type { LibQ } from "../types";
import type { Ctx } from "./pool";
import { DIMS, NONE, OTHER, resultBucket, type Blueprint, type DimKey, type ShareDim } from "./spec";

const DAY = 86_400_000;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
/** A number in (0, 1) fixed by the seed and the question — the question's "dice roll". */
export function unitRandom(seed: number, id: string): number {
  return (fmix(fnv1a(`${seed >>> 0}:${id}`)) + 0.5) / 4294967296;
}

export interface Weighting { weight: number; factors: string[] }

export function weigh(
  q: LibQ,
  f: Pick<Blueprint, "favourWrong" | "favourStale" | "favourWeak">,
  accuracy: Map<string, number>,
  now: number,
): Weighting {
  let w = 1;
  const factors: string[] = [];
  if (f.favourWrong && q.last_result === "incorrect") { w *= 3; factors.push("wrong last time"); }
  if (f.favourWrong && q.last_result === "partial") { w *= 2; factors.push("partly right last time"); }
  if (f.favourStale) {
    if (q.last_attempted_at === null) { w *= 2; factors.push("never attempted"); }
    else {
      const days = (now - q.last_attempted_at) / DAY;
      if (days >= 30) { w *= 2; factors.push("not seen for 30+ days"); }
      else if (days >= 14) { w *= 1.5; factors.push("not seen for 14+ days"); }
    }
  }
  if (f.favourWeak) {
    let boost = 1;
    for (const [cid] of q.concepts) {
      const acc = accuracy.get(cid);
      if (acc !== undefined && acc < 0.6) boost = Math.max(boost, 1 + (0.6 - acc) * 3);
    }
    if (boost > 1) { w *= boost; factors.push("weak concept"); }
  }
  return { weight: w, factors };
}

/** Exact whole numbers that add up to `total` (largest remainder; ties go to the earlier entry). */
export function apportion(exact: [string, number][], total: number): Map<string, number> {
  const base = exact.map(([k, x]) => {
    const n = Math.floor(x + 1e-9);
    return { k, n, rem: x - n };
  });
  let left = total - base.reduce((a, b) => a + b.n, 0);
  const byRem = base.map((b, i) => ({ b, i })).sort((x, y) => y.b.rem - x.b.rem || x.i - y.i);
  for (const { b } of byRem) {
    if (left <= 0) break;
    b.n++;
    left--;
  }
  return new Map(base.map((b) => [b.k, b.n]));
}

/** Shares → whole-number targets for a paper of `want` questions. The rest goes to OTHER. */
export function shareTargets(s: ShareDim, want: number): { targets: Map<string, number>; scaled: boolean; total: number } {
  const entries = Object.entries(s.values).filter(([, v]) => v > 0);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  const cap = s.unit === "percent" ? 100 : want;
  const scaled = total > cap;
  const exact: [string, number][] = entries.map(([k, v]) => [k, scaled ? (want * v) / total : s.unit === "percent" ? (want * v) / 100 : v]);
  exact.push([OTHER, scaled ? 0 : s.unit === "percent" ? (want * (100 - total)) / 100 : want - total]);
  return { targets: apportion(exact, want), scaled, total };
}

export const activeDims = (bp: Blueprint): DimKey[] => DIMS.filter((d) => bp.shares[d].on && Object.values(bp.shares[d].values).some((v) => v > 0));

/** The listed concept a question counts towards: its strongest tag, matched at the most specific listed level. */
export function primaryConcept(q: LibQ, ctx: Ctx, keys: Set<string>): string {
  let best = OTHER, bestW = -1, bestDist = Infinity;
  for (const [c, w] of ctx.tags.get(q.id) ?? []) {
    const chain = ctx.chain.get(c) ?? [];
    for (let i = 0; i < chain.length; i++) {
      if (!keys.has(chain[i])) continue;
      if (w > bestW || (w === bestW && (i < bestDist || (i === bestDist && chain[i] < best)))) { best = chain[i]; bestW = w; bestDist = i; }
      break;
    }
  }
  return best;
}

export function dimValue(dim: Exclude<DimKey, "concept">, q: LibQ): string {
  return dim === "subject" ? q.subject_id ?? NONE : dim === "difficulty" ? q.difficulty_code ?? NONE : dim === "format" ? q.answer_format : resultBucket(q);
}

export function bucketOf(dim: DimKey, q: LibQ, ctx: Ctx, keys: Set<string>): string {
  if (dim === "concept") return primaryConcept(q, ctx, keys);
  const v = dimValue(dim, q);
  return keys.has(v) ? v : OTHER;
}

export interface PlanPick {
  q: LibQ;
  key: number; // priority: higher = picked earlier
  weight: number;
  factors: string[];
  pinned: boolean;
  fills: [DimKey, string][]; // the share bucket it counts towards, per active mix
  over: DimKey[]; // mixes it pushes past target because nothing better fitted
}
export interface TargetRow { value: string; target: number; actual: number; available: number }
export interface DimReport { dim: DimKey; unit: "percent" | "count"; scaled: boolean; rows: TargetRow[] }
export interface Plan {
  picks: PlanPick[]; // in paper order
  want: number; // length asked for (never below the number of pinned questions)
  shortfall: number; // want − picks
  candidates: number; // questions that could be picked (pool − removed + pinned)
  reports: DimReport[];
  offTarget: number; // questions missing from targets in total
}

export function planPaper(o: {
  lib: LibQ[];
  pool: LibQ[];
  bp: Blueprint;
  seed: number;
  ctx: Ctx;
  accuracy?: Map<string, number>;
  now?: number;
}): Plan {
  const { bp, ctx } = o;
  const now = o.now ?? Date.now();
  const accuracy = o.accuracy ?? new Map<string, number>();
  const byId = new Map(o.lib.map((q) => [q.id, q]));
  const pinnedQs: LibQ[] = [];
  const pinnedIds = new Set<string>();
  for (const id of bp.pinned) {
    const q = byId.get(id);
    if (q && !pinnedIds.has(id)) { pinnedIds.add(id); pinnedQs.push(q); }
  }
  const excluded = new Set(bp.excluded);
  const cands = o.pool.filter((q) => !excluded.has(q.id) && !pinnedIds.has(q.id));
  const want = Math.max(1, Math.trunc(bp.count) || 1, pinnedQs.length);

  const info = new Map<string, { key: number; weight: number; factors: string[] }>();
  const infoOf = (q: LibQ) => {
    let i = info.get(q.id);
    if (!i) {
      const w = weigh(q, bp, accuracy, now);
      i = { key: Math.log(unitRandom(o.seed, q.id)) / w.weight, weight: w.weight, factors: w.factors };
      info.set(q.id, i);
    }
    return i;
  };
  const byPriority = (a: LibQ, b: LibQ) => infoOf(b).key - infoOf(a).key || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const order = [...cands].sort(byPriority);

  const dims = activeDims(bp).map((dim) => {
    const share = bp.shares[dim];
    const t = shareTargets(share, want);
    return { dim, share, targets: t.targets, scaled: t.scaled, keys: new Set([...t.targets.keys()].filter((k) => k !== OTHER)) };
  });
  const bcache = new Map<string, string[]>();
  const buckets = (q: LibQ) => {
    let b = bcache.get(q.id);
    if (!b) { b = dims.map((d) => bucketOf(d.dim, q, ctx, d.keys)); bcache.set(q.id, b); }
    return b;
  };
  const need = dims.map((d) => new Map(d.targets));
  const add = (b: string[], by: number) => b.forEach((v, j) => need[j].set(v, need[j].get(v)! + by));

  const chosen: LibQ[] = [];
  const used = new Set<string>();
  const take = (q: LibQ) => { used.add(q.id); chosen.push(q); add(buckets(q), -1); };
  for (const q of pinnedQs) take(q);

  if (!dims.length) {
    for (const q of order) {
      if (chosen.length >= want) break;
      take(q);
    }
  } else {
    let start = 0;
    while (chosen.length < want) {
      let best = -1, bestFull = Infinity;
      for (let i = start; i < order.length; i++) {
        const q = order[i];
        if (used.has(q.id)) { if (i === start) start++; continue; }
        const b = buckets(q);
        let full = 0;
        for (let j = 0; j < b.length; j++) if (need[j].get(b[j])! <= 0) full++;
        if (full === 0) { best = i; break; }
        if (full < bestFull) { bestFull = full; best = i; }
      }
      if (best < 0) break;
      take(order[best]);
    }

    // Swap pass: trade a question sitting in an over-full bucket for an unused one that
    // reduces the total distance from the targets. Each swap strictly improves, so it ends.
    const delta = (bx: string[], by: string[]) => {
      let d = 0;
      for (let j = 0; j < dims.length; j++) {
        if (bx[j] === by[j]) continue;
        const nx = need[j].get(bx[j])!, ny = need[j].get(by[j])!;
        d += Math.abs(nx + 1) - Math.abs(nx) + Math.abs(ny - 1) - Math.abs(ny);
      }
      return d;
    };
    const overfull = () => need.some((m) => [...m.values()].some((v) => v < 0));
    for (let guard = 0; guard < want * 3 && overfull(); guard++) {
      let swapped = false;
      for (let xi = chosen.length - 1; xi >= 0 && !swapped; xi--) {
        const x = chosen[xi];
        if (pinnedIds.has(x.id)) continue;
        const bx = buckets(x);
        if (!bx.some((v, j) => need[j].get(v)! < 0)) continue;
        for (const y of order) {
          if (used.has(y.id)) continue;
          const by = buckets(y);
          if (!by.some((v, j) => need[j].get(v)! > 0)) continue;
          if (delta(bx, by) < 0) {
            used.delete(x.id);
            used.add(y.id);
            add(bx, 1);
            add(by, -1);
            chosen[xi] = y;
            swapped = true;
            break;
          }
        }
      }
      if (!swapped) break;
    }
  }

  const picks: PlanPick[] = chosen.map((q) => {
    const i = infoOf(q);
    const b = dims.length ? buckets(q) : [];
    return { q, key: i.key, weight: i.weight, factors: i.factors, pinned: pinnedIds.has(q.id), fills: dims.map((d, j) => [d.dim, b[j]] as [DimKey, string]), over: [] };
  });
  // Mark which picks went past a target (least preferred first, pinned last).
  dims.forEach((d, j) => {
    for (const [v, n] of need[j]) {
      let left = -n;
      for (const pinnedPass of [false, true]) {
        for (let k = picks.length - 1; k >= 0 && left > 0; k--) {
          const p = picks[k];
          if (p.pinned === pinnedPass && p.fills[j][1] === v) { p.over.push(d.dim); left--; }
        }
      }
    }
  });

  const reports: DimReport[] = dims.map((d, j) => {
    const avail = new Map<string, number>();
    for (const q of pinnedQs) avail.set(buckets(q)[j], (avail.get(buckets(q)[j]) ?? 0) + 1);
    for (const q of cands) avail.set(buckets(q)[j], (avail.get(buckets(q)[j]) ?? 0) + 1);
    const rows = [...d.targets.keys()].map((v) => ({ value: v, target: d.targets.get(v)!, actual: d.targets.get(v)! - need[j].get(v)!, available: avail.get(v) ?? 0 }));
    return { dim: d.dim, unit: d.share.unit, scaled: d.scaled, rows };
  });
  const offTarget = reports.reduce((a, r) => a + r.rows.reduce((x, row) => x + Math.max(0, row.target - row.actual), 0), 0);

  return {
    picks: orderPicks(picks, bp, ctx),
    want,
    shortfall: Math.max(0, want - picks.length),
    candidates: cands.length + pinnedQs.length,
    reports,
    offTarget,
  };
}

/** Name path of a question's strongest concept tag, e.g. "Number › Fractions". */
export function mainConceptPath(q: LibQ, ctx: Ctx): string {
  const tags = [...(ctx.tags.get(q.id) ?? [])].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (!tags.length) return "";
  return conceptPathOf(ctx, tags[0][0]);
}
export function conceptPathOf(ctx: Ctx, id: string): string {
  return [...(ctx.chain.get(id) ?? [id])].reverse().map((c) => ctx.concept.get(c)?.name ?? "?").join(" › ");
}

export function orderPicks(picks: PlanPick[], bp: Pick<Blueprint, "order" | "manual">, ctx: Ctx): PlanPick[] {
  const byKey = (a: PlanPick, b: PlanPick) => b.key - a.key || (a.q.id < b.q.id ? -1 : a.q.id > b.q.id ? 1 : 0);
  const NO = 1e9;
  const rank = (p: PlanPick) => (p.q.difficulty_code ? ctx.rank.get(p.q.difficulty_code) ?? NO : NO);
  const list = [...picks].sort(byKey);
  switch (bp.order) {
    case "easy_first":
      return list.sort((a, b) => rank(a) - rank(b) || byKey(a, b));
    case "hard_first":
      return list.sort((a, b) => {
        const ra = rank(a), rb = rank(b);
        if (ra === NO || rb === NO) return ra === rb ? byKey(a, b) : ra === NO ? 1 : -1;
        return rb - ra || byKey(a, b);
      });
    case "subject": {
      const sname = (p: PlanPick) => (p.q.subject_id ? ctx.subjectName.get(p.q.subject_id) ?? "￿" : "￿￿");
      const path = new Map(list.map((p) => [p.q.id, mainConceptPath(p.q, ctx) || "￿"]));
      return list.sort((a, b) => sname(a).localeCompare(sname(b)) || path.get(a.q.id)!.localeCompare(path.get(b.q.id)!) || rank(a) - rank(b) || byKey(a, b));
    }
    case "manual": {
      const byId = new Map(list.map((p) => [p.q.id, p]));
      const listed = new Set(bp.manual);
      const unplaced = list.filter((p) => !listed.has(p.q.id));
      const placed = new Set<string>();
      const out: PlanPick[] = [];
      for (const id of bp.manual) {
        const p = byId.get(id);
        if (p) {
          if (!placed.has(id)) { out.push(p); placed.add(id); }
        } else if (unplaced.length) {
          // A removed question's slot goes to the next new pick, so a replacement keeps its place.
          const u = unplaced.shift()!;
          out.push(u);
          placed.add(u.q.id);
        }
      }
      return [...out, ...unplaced];
    }
    default:
      return list;
  }
}
