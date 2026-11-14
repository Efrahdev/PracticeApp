// Paper sampler (FR-3). Runs on the device. Same candidates + settings + seed
// always give the same paper (FR-3.5): candidates are sorted by ID and every
// random number comes from a seeded generator.
import type { LibQ } from "./types";

export const GENERATOR_VERSION = 1;

export interface SamplingSettings {
  favourWrong: boolean; // FR-3.4: got it wrong / partial last time
  favourStale: boolean; // FR-3.4: not seen recently (or never)
  favourWeak: boolean; // FR-3.4: weak concepts
  mix: Record<string, number>; // FR-3.3: difficulty code → percent; empty = no mix
}

export const defaultSettings = (): SamplingSettings => ({ favourWrong: false, favourStale: false, favourWeak: false, mix: {} });

export interface Pick {
  q: LibQ;
  reason: { target: string; weight: number; factors: string[]; score: number };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000_000;

const DAY = 86_400_000;

export function buildPaper(
  candidates: LibQ[],
  count: number,
  seed: number,
  settings: SamplingSettings,
  conceptAccuracy: Map<string, number> = new Map(),
  now = Date.now(),
): { picks: Pick[]; shortfall: number } {
  const pool = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rnd = mulberry32(seed);
  const scored = pool.map((q) => {
    let w = 1;
    const factors: string[] = [];
    if (settings.favourWrong && q.last_result === "incorrect") { w *= 3; factors.push("wrong last time"); }
    if (settings.favourWrong && q.last_result === "partial") { w *= 2; factors.push("partial last time"); }
    if (settings.favourStale) {
      if (q.last_attempted_at === null) { w *= 2; factors.push("never attempted"); }
      else {
        const days = (now - q.last_attempted_at) / DAY;
        if (days >= 30) { w *= 2; factors.push("not seen for 30+ days"); }
        else if (days >= 14) { w *= 1.5; factors.push("not seen for 14+ days"); }
      }
    }
    if (settings.favourWeak) {
      let boost = 1;
      for (const [cid] of q.concepts) {
        const acc = conceptAccuracy.get(cid);
        if (acc !== undefined && acc < 0.6) boost = Math.max(boost, 1 + (0.6 - acc) * 3);
      }
      if (boost > 1) { w *= boost; factors.push("weak concept"); }
    }
    // Weighted sampling without replacement (Efraimidis–Spirakis): larger key wins.
    const u = Math.max(rnd(), 1e-12);
    const key = Math.log(u) / w;
    return { q, w, factors, key };
  });
  scored.sort((a, b) => b.key - a.key);

  const want = Math.min(count, pool.length);
  const chosen: Pick[] = [];
  const used = new Set<string>();
  const take = (s: (typeof scored)[number], target: string) => {
    used.add(s.q.id);
    chosen.push({ q: s.q, reason: { target, weight: Math.round(s.w * 100) / 100, factors: s.factors, score: Math.round(s.key * 1000) / 1000 } });
  };

  const mixEntries = Object.entries(settings.mix).filter(([, p]) => p > 0);
  if (mixEntries.length) {
    const total = mixEntries.reduce((a, [, p]) => a + p, 0);
    // Largest-remainder rounding so quotas add up exactly.
    const raw = mixEntries.map(([code, p]) => ({ code, exact: (want * p) / total }));
    const quotas = raw.map((r) => ({ code: r.code, n: Math.floor(r.exact), rem: r.exact - Math.floor(r.exact) }));
    let left = want - quotas.reduce((a, q) => a + q.n, 0);
    [...quotas].sort((a, b) => b.rem - a.rem || (a.code < b.code ? -1 : 1)).forEach((q) => { if (left > 0) { q.n++; left--; } });
    for (const { code, n } of quotas) {
      let got = 0;
      for (const s of scored) {
        if (got >= n) break;
        if (!used.has(s.q.id) && s.q.difficulty_code === code) { take(s, `difficulty: ${code}`); got++; }
      }
    }
  }
  for (const s of scored) {
    if (chosen.length >= want) break;
    if (!used.has(s.q.id)) take(s, mixEntries.length ? "fill (mix target short)" : "any");
  }
  return { picks: chosen, shortfall: Math.max(0, count - pool.length) };
}
