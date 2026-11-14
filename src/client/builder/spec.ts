// Paper blueprint for generator v2: every rule that decides which questions a paper
// gets. It is saved as the paper's `sampling_settings`, so a paper can always be
// explained (and rebuilt) from what is stored with it. No schema change needed.
import { emptyFilter, type FilterDef } from "../filter";
import type { LibQ } from "../types";

export const GENERATOR_V2 = 2;

/** Bucket key for "no subject" / "no difficulty label". */
export const NONE = "__none";
/** Bucket key for "everything not given its own share" in a mix. */
export const OTHER = "__other";

export type Unit = "days" | "weeks" | "months";
export const UNIT_DAYS: Record<Unit, number> = { days: 1, weeks: 7, months: 30 };

/** Inclusive range; null = open on that side. */
export interface Range { min: number | null; max: number | null }

export interface Recency {
  mode: "any" | "never" | "more_than" | "within" | "between";
  n: number; // more_than / within amount, or the near end of "between"
  m: number; // far end of "between"
  unit: Unit;
  includeNever: boolean; // "more than": also count questions never attempted
}

export interface Added { mode: "any" | "within" | "more_than"; n: number; unit: Unit }

export type ResultBucket = "never" | "incorrect" | "partial" | "correct" | "ungraded";
export const RESULT_BUCKETS: ResultBucket[] = ["never", "incorrect", "partial", "correct", "ungraded"];

export type SolutionRule = "any" | "has" | "verified" | "ai" | "none";
export type KeyRule = "any" | "has" | "none";

/** Which questions may go into the paper. Every rule is AND-ed. */
export interface PoolSpec {
  text: string; // words, Q number or ID
  tree: string[] | null; // ticked concept ids + "u:<subject>" (not tagged); null = everything
  difficulty: string[] | null; // ticked labels (NONE = no label); null = all
  recency: Recency;
  attempts: Range;
  results: ResultBucket[]; // [] = any
  avgMinutes: Range; // average time taken, minutes
  personal: Range; // personal difficulty, percent
  formats: string[]; // [] = any
  marks: Range;
  solution: SolutionRule;
  key: KeyRule;
  imports: string[]; // [] = any
  added: Added;
  includeArchived: boolean;
  advanced: FilterDef; // full AND/OR conditions (the Library's filter arrives here)
}

export type DimKey = "subject" | "concept" | "difficulty" | "result" | "format";
export const DIMS: DimKey[] = ["subject", "concept", "difficulty", "result", "format"];

/** One way of splitting the paper. Values without a share make up the "rest". */
export interface ShareDim { on: boolean; unit: "percent" | "count"; values: Record<string, number> }

export type Order = "picked" | "easy_first" | "hard_first" | "subject" | "manual";

export interface Blueprint {
  v: 2;
  count: number;
  pool: PoolSpec;
  shares: Record<DimKey, ShareDim>;
  favourWrong: boolean;
  favourStale: boolean;
  favourWeak: boolean;
  order: Order;
  pinned: string[]; // always in the paper
  excluded: string[]; // never in this paper
  manual: string[]; // hand-made order (question ids)
}

export const anyRange = (): Range => ({ min: null, max: null });
export const rangeOn = (r: Range) => r.min !== null || r.max !== null;

export function defaultPool(): PoolSpec {
  return {
    text: "",
    tree: null,
    difficulty: null,
    recency: { mode: "any", n: 3, m: 8, unit: "weeks", includeNever: true },
    attempts: anyRange(),
    results: [],
    avgMinutes: anyRange(),
    personal: anyRange(),
    formats: [],
    marks: anyRange(),
    solution: "any",
    key: "any",
    imports: [],
    added: { mode: "any", n: 30, unit: "days" },
    includeArchived: false,
    advanced: emptyFilter(),
  };
}

export const defaultShare = (): ShareDim => ({ on: false, unit: "percent", values: {} });

export function defaultBlueprint(count = 10): Blueprint {
  return {
    v: 2,
    count,
    pool: defaultPool(),
    shares: { subject: defaultShare(), concept: defaultShare(), difficulty: defaultShare(), result: defaultShare(), format: defaultShare() },
    favourWrong: false,
    favourStale: false,
    favourWeak: false,
    order: "picked",
    pinned: [],
    excluded: [],
    manual: [],
  };
}

/** Which "last result" bucket a question is in. */
export function resultBucket(q: LibQ): ResultBucket {
  if (!q.attempt_count && q.last_attempted_at === null) return "never";
  return q.last_result ?? "ungraded";
}

export const hasConditions = (d: FilterDef) => d.groups.some((g) => g.conds.length > 0);

// ------------------------------------------------------------------ normalising stored data

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
const range = (v: any): Range => ({ min: numOrNull(v?.min), max: numOrNull(v?.max) });
const UNITS = ["days", "weeks", "months"] as const;

/** Fills in anything missing or malformed (older saved state, hand-edited JSON), so the builder never crashes on it. */
export function normaliseBlueprint(raw: unknown): Blueprint {
  const d = defaultBlueprint();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as any;
  const p = r.pool ?? {};
  const dp = d.pool;
  const adv = p.advanced && p.advanced.v === 1 && Array.isArray(p.advanced.groups) ? (p.advanced as FilterDef) : emptyFilter();
  const pool: PoolSpec = {
    text: typeof p.text === "string" ? p.text : "",
    tree: p.tree === null || p.tree === undefined ? null : strs(p.tree),
    difficulty: p.difficulty === null || p.difficulty === undefined ? null : strs(p.difficulty),
    recency: {
      mode: oneOf(p.recency?.mode, ["any", "never", "more_than", "within", "between"] as const, "any"),
      n: Math.max(0, num(p.recency?.n, dp.recency.n)),
      m: Math.max(0, num(p.recency?.m, dp.recency.m)),
      unit: oneOf(p.recency?.unit, UNITS, dp.recency.unit),
      includeNever: typeof p.recency?.includeNever === "boolean" ? p.recency.includeNever : true,
    },
    attempts: range(p.attempts),
    results: strs(p.results).filter((x): x is ResultBucket => (RESULT_BUCKETS as string[]).includes(x)),
    avgMinutes: range(p.avgMinutes),
    personal: range(p.personal),
    formats: strs(p.formats),
    marks: range(p.marks),
    solution: oneOf(p.solution, ["any", "has", "verified", "ai", "none"] as const, "any"),
    key: oneOf(p.key, ["any", "has", "none"] as const, "any"),
    imports: strs(p.imports),
    added: {
      mode: oneOf(p.added?.mode, ["any", "within", "more_than"] as const, "any"),
      n: Math.max(0, num(p.added?.n, dp.added.n)),
      unit: oneOf(p.added?.unit, UNITS, dp.added.unit),
    },
    includeArchived: !!p.includeArchived,
    advanced: adv,
  };
  const shares = { ...d.shares };
  for (const k of DIMS) {
    const s = r.shares?.[k];
    if (!s || typeof s !== "object") continue;
    const values: Record<string, number> = {};
    for (const [vk, vv] of Object.entries(s.values ?? {})) if (typeof vv === "number" && Number.isFinite(vv) && vv > 0) values[vk] = vv;
    shares[k] = { on: !!s.on, unit: s.unit === "count" ? "count" : "percent", values };
  }
  return {
    v: 2,
    count: Math.max(1, Math.trunc(num(r.count, d.count))),
    pool,
    shares,
    favourWrong: !!r.favourWrong,
    favourStale: !!r.favourStale,
    favourWeak: !!r.favourWeak,
    order: oneOf(r.order, ["picked", "easy_first", "hard_first", "subject", "manual"] as const, "picked"),
    pinned: [...new Set(strs(r.pinned))],
    excluded: [...new Set(strs(r.excluded))],
    manual: strs(r.manual),
  };
}
