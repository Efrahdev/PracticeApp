import { describe, expect, it } from "vitest";
import { emptyFilter } from "../src/client/filter";
import { planPaper, shareTargets, unitRandom } from "../src/client/builder/engine";
import { evaluatePool, makeCtx, treeToggle } from "../src/client/builder/pool";
import { defaultBlueprint, normaliseBlueprint, OTHER, type Blueprint } from "../src/client/builder/spec";
import type { Boot, LibQ } from "../src/client/types";

const NOW = Date.UTC(2026, 10, 14);
const DAY = 86_400_000;

const q = (id: string, extra: Partial<LibQ> = {}): LibQ => ({
  id, subject_id: "maths", difficulty_code: "easy", answer_format: "none", created_at: NOW - 100 * DAY, archived_at: null,
  marks: 2, content_format: "qpack_v1", has_solution: null, fields: {}, batches: ["b1"],
  version_id: "v" + id, version_no: 1, qno: id, plain_text: "question text " + id, file_name: "f.json", concepts: [], has_key: 0,
  attempt_count: null, graded_count: null, correct_count: null, score_permille_sum: null, total_time_seconds: null,
  last_attempted_at: null, last_time_seconds: null, last_result: null, personal_difficulty_permille: null, familiarity_permille: null, ...extra,
});

const boot: Boot = {
  subjects: [
    { id: "maths", name: "Maths", created_at: 0, archived_at: null },
    { id: "phys", name: "Physics", created_at: 0, archived_at: null },
  ],
  concepts: [
    { id: "alg", subject_id: "maths", parent_id: null, name: "Algebra", archived_at: null, merged_into_id: null },
    { id: "quad", subject_id: "maths", parent_id: "alg", name: "Quadratics", archived_at: null, merged_into_id: null },
    { id: "geo", subject_id: "maths", parent_id: null, name: "Geometry", archived_at: null, merged_into_id: null },
    { id: "old", subject_id: "maths", parent_id: null, name: "Old geometry", archived_at: 1, merged_into_id: "geo" },
    { id: "mech", subject_id: "phys", parent_id: null, name: "Mechanics", archived_at: null, merged_into_id: null },
  ],
  difficulties: [
    { code: "easy", label: "Easy", sort_rank: 1, archived_at: null },
    { code: "mid", label: "Medium", sort_rank: 2, archived_at: null },
    { code: "hard", label: "Hard", sort_rank: 3, archived_at: null },
  ],
  errorTypes: [], filters: [], fields: [], imports: [], schemaVersion: 3,
};

// 120 questions: maths/physics × easy/mid/hard, some attempted at known ages.
const lib: LibQ[] = Array.from({ length: 120 }, (_, i) => {
  const id = String(i).padStart(3, "0");
  const phys = i % 3 === 0;
  const diff = ["easy", "mid", "hard"][i % 4 === 0 ? 2 : i % 2];
  const concepts: [string, number][] = phys ? [["mech", 1]] : i % 5 === 0 ? [] : i % 2 ? [["quad", 1]] : [["geo", 1], ["alg", 0.4]];
  const attempted = i % 6 === 1;
  return q(id, {
    subject_id: phys ? "phys" : "maths",
    difficulty_code: diff,
    concepts,
    answer_format: i % 7 === 0 ? "numeric" : "none",
    ...(attempted ? { attempt_count: (i % 4) + 1, last_attempted_at: NOW - (i % 60) * DAY, last_result: i % 18 === 1 ? "incorrect" : "correct", total_time_seconds: 300 * ((i % 4) + 1) } : {}),
  });
});
lib.push(q("old1", { concepts: [["old", 1]] })); // tagged with a merged concept → counts as Geometry
lib.push(q("arch", { archived_at: NOW - DAY }));

const ctx = makeCtx(boot, lib);
const bp = (f: (b: Blueprint) => void = () => {}) => { const b = defaultBlueprint(20); f(b); return b; };
const run = (b: Blueprint, seed = 7) => {
  const ev = evaluatePool(lib, ctx, b.pool, NOW);
  return { ev, plan: planPaper({ lib, pool: ev.pool, bp: b, seed, ctx, now: NOW }) };
};
const ids = (r: ReturnType<typeof run>) => r.plan.picks.map((p) => p.q.id);

describe("builder pool", () => {
  it("excludes archived questions unless asked, and follows concept merges", () => {
    expect(run(bp()).ev.pool.some((x) => x.id === "arch")).toBe(false);
    expect(run(bp((b) => (b.pool.includeArchived = true))).ev.pool.some((x) => x.id === "arch")).toBe(true);
    expect(ctx.tags.get("old1")).toEqual([["geo", 1]]);
  });

  it("tree: unticking a sub-concept keeps questions tagged on the parent itself", () => {
    const sel = treeToggle(ctx, null, ctx.node.get("quad")!);
    expect(sel).not.toContain("quad");
    expect(sel).toContain("alg");
    const pool = run(bp((b) => (b.pool.tree = sel))).ev.pool;
    expect(pool.some((x) => x.concepts.some(([c]) => c === "quad"))).toBe(false);
    expect(pool.some((x) => x.concepts.some(([c]) => c === "alg"))).toBe(true); // geo+alg questions stay
    expect(treeToggle(ctx, sel, ctx.node.get("quad")!)).toBeNull(); // ticking it back = everything again
  });

  it("tree: only Physics, and only maths questions with no concept", () => {
    const onlyPhys = treeToggle(ctx, [], ctx.node.get("s:phys")!);
    expect(run(bp((b) => (b.pool.tree = onlyPhys))).ev.pool.every((x) => x.subject_id === "phys")).toBe(true);
    const untagged = run(bp((b) => (b.pool.tree = ["u:maths"]))).ev.pool;
    expect(untagged.length).toBeGreaterThan(0);
    expect(untagged.every((x) => x.subject_id === "maths" && x.concepts.length === 0)).toBe(true);
  });

  it("history: last attempted more than 3 weeks ago, with and without never-attempted", () => {
    const withNever = run(bp((b) => (b.pool.recency = { mode: "more_than", n: 3, m: 0, unit: "weeks", includeNever: true }))).ev.pool;
    const without = run(bp((b) => (b.pool.recency = { mode: "more_than", n: 3, m: 0, unit: "weeks", includeNever: false }))).ev.pool;
    expect(without.every((x) => x.last_attempted_at !== null && NOW - x.last_attempted_at > 21 * DAY)).toBe(true);
    expect(withNever.length).toBe(without.length + lib.filter((x) => x.last_attempted_at === null && !x.archived_at).length);
    const between = run(bp((b) => (b.pool.recency = { mode: "between", n: 1, m: 2, unit: "months", includeNever: true }))).ev.pool;
    expect(between.every((x) => NOW - x.last_attempted_at! >= 30 * DAY && NOW - x.last_attempted_at! <= 60 * DAY)).toBe(true);
  });

  it("history: attempts range, last result and average time", () => {
    const r = run(bp((b) => { b.pool.attempts = { min: 2, max: 3 }; b.pool.results = ["correct"]; b.pool.avgMinutes = { min: 5, max: null }; })).ev.pool;
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => x.attempt_count! >= 2 && x.attempt_count! <= 3 && x.last_result === "correct")).toBe(true);
    const never = run(bp((b) => (b.pool.results = ["never"]))).ev.pool;
    expect(never.every((x) => !x.attempt_count)).toBe(true);
  });

  it("facet counts ignore their own rule", () => {
    const { ev } = run(bp((b) => (b.pool.difficulty = ["hard"])));
    expect(ev.pool.every((x) => x.difficulty_code === "hard")).toBe(true);
    const live = lib.filter((x) => !x.archived_at);
    expect(ev.counts.difficulty.get("easy")).toBe(live.filter((x) => x.difficulty_code === "easy").length);
    expect(ev.counts.tree.get("s:phys")).toBe(ev.pool.filter((x) => x.subject_id === "phys").length);
  });

  it("advanced conditions from the Library are applied", () => {
    const def = emptyFilter();
    def.groups[0].conds.push({ type: "subject", ids: ["phys"] });
    expect(run(bp((b) => (b.pool.advanced = def))).ev.pool.every((x) => x.subject_id === "phys")).toBe(true);
  });
});

describe("builder sampler", () => {
  it("same blueprint + seed = same paper; another seed = another paper; no repeats", () => {
    const a = ids(run(bp(), 11));
    expect(ids(run(bp(), 11))).toEqual(a);
    expect(ids(run(bp(), 12))).not.toEqual(a);
    expect(new Set(a).size).toBe(20);
  });

  it("replacing one question keeps every other pick", () => {
    const a = ids(run(bp(), 3));
    const b = ids(run(bp((x) => (x.excluded = [a[4]])), 3));
    expect(b).not.toContain(a[4]);
    expect(b.filter((id) => a.includes(id)).length).toBe(19);
  });

  it("meets two mixes at once (subject and difficulty)", () => {
    const b = bp((x) => {
      x.shares.subject = { on: true, unit: "percent", values: { maths: 60, phys: 40 } };
      x.shares.difficulty = { on: true, unit: "count", values: { easy: 10, mid: 6, hard: 4 } };
    });
    const { plan } = run(b);
    const picks = plan.picks.map((p) => p.q);
    expect(picks.filter((p) => p.subject_id === "maths").length).toBe(12);
    expect(picks.filter((p) => p.subject_id === "phys").length).toBe(8);
    expect(picks.filter((p) => p.difficulty_code === "easy").length).toBe(10);
    expect(picks.filter((p) => p.difficulty_code === "hard").length).toBe(4);
    expect(plan.offTarget).toBe(0);
  });

  it("concept shares count each question once, at its strongest tag", () => {
    const { plan } = run(bp((x) => (x.shares.concept = { on: true, unit: "percent", values: { alg: 50, geo: 25 } })));
    const rows = new Map(plan.reports[0].rows.map((r) => [r.value, r]));
    expect(rows.get("alg")!.actual).toBe(10);
    expect(rows.get("geo")!.actual).toBe(5);
    expect(rows.get(OTHER)!.actual).toBe(5);
  });

  it("reports what it cannot meet instead of hiding it", () => {
    const { plan } = run(bp((x) => {
      x.pool.tree = ["mech"]; // physics only
      x.shares.subject = { on: true, unit: "percent", values: { maths: 50 } };
    }));
    const maths = plan.reports[0].rows.find((r) => r.value === "maths")!;
    expect(maths.target).toBe(10);
    expect(maths.actual).toBe(0);
    expect(plan.offTarget).toBe(10);
    expect(plan.picks.length).toBe(20);
    expect(plan.picks.filter((p) => p.over.includes("subject")).length).toBe(10);
  });

  it("shares over 100% are scaled to fit; targets always add up to the length", () => {
    const t = shareTargets({ on: true, unit: "percent", values: { a: 70, b: 50 } }, 12);
    expect(t.scaled).toBe(true);
    expect([...t.targets.values()].reduce((a, b) => a + b, 0)).toBe(12);
    expect(shareTargets({ on: true, unit: "percent", values: { a: 33.3, b: 33.3 } }, 10).targets.get(OTHER)).toBe(4);
  });

  it("pinned questions are always in, even outside the filters; the length grows to fit them", () => {
    const b = bp((x) => { x.count = 2; x.pinned = ["arch", "000", "001"]; });
    const { plan } = run(b);
    expect(plan.want).toBe(3);
    expect(plan.picks.map((p) => p.q.id).sort()).toEqual(["000", "001", "arch"]);
    expect(plan.picks.every((p) => p.pinned)).toBe(true);
  });

  it("orders easiest first, and keeps a manual order with replacements in place", () => {
    const easy = run(bp((x) => (x.order = "easy_first"))).plan.picks.map((p) => ctx.rank.get(p.q.difficulty_code!)!);
    expect(easy).toEqual([...easy].sort((a, b) => a - b));
    const base = ids(run(bp()));
    const manual = [...base].reverse();
    const r = ids(run(bp((x) => { x.order = "manual"; x.manual = manual; })));
    expect(r).toEqual(manual);
    const replaced = ids(run(bp((x) => { x.order = "manual"; x.manual = manual; x.excluded = [manual[2]]; })));
    expect(replaced[0]).toBe(manual[0]);
    expect(replaced[1]).toBe(manual[1]);
    expect(replaced[2]).not.toBe(manual[2]);
    expect(replaced[3]).toBe(manual[3]);
  });

  it("favouring wrong answers lifts them", () => {
    const wrong = lib.filter((x) => x.last_result === "incorrect").map((x) => x.id);
    const plain = ids(run(bp((x) => (x.count = 10)), 5)).filter((id) => wrong.includes(id)).length;
    const fav = ids(run(bp((x) => { x.count = 10; x.favourWrong = true; }), 5)).filter((id) => wrong.includes(id)).length;
    expect(fav).toBeGreaterThanOrEqual(plain);
  });

  it("random numbers are fixed per seed and question", () => {
    expect(unitRandom(1, "a")).toBe(unitRandom(1, "a"));
    expect(unitRandom(1, "a")).not.toBe(unitRandom(2, "a"));
    expect(unitRandom(1, "a")).toBeGreaterThan(0);
    expect(unitRandom(1, "a")).toBeLessThan(1);
  });

  it("normalises stored or partial settings safely", () => {
    const n = normaliseBlueprint({ count: "x", pool: { recency: { mode: "bogus" }, tree: ["alg", 3] }, shares: { subject: { on: true, values: { maths: -5, phys: 30 } } } });
    expect(n.count).toBe(10);
    expect(n.pool.recency.mode).toBe("any");
    expect(n.pool.tree).toEqual(["alg"]);
    expect(n.shares.subject.values).toEqual({ phys: 30 });
    expect(normaliseBlueprint(null)).toEqual(defaultBlueprint());
  });
});
