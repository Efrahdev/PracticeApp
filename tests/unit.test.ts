import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { parseQuestionBank, contentFingerprint, sha256Hex } from "../src/shared/parse";
import { compile, emptyFilter } from "../src/client/filter";
import { buildPaper, defaultSettings } from "../src/client/sampler";
import type { LibQ } from "../src/client/types";

const html = readFileSync("tests/fixtures/fractions-sample.html", "utf8");

describe("parser", () => {
  const { document } = parseHTML(html);
  const r = parseQuestionBank(document as unknown as Document);
  it("splits on question numbers with bands, categories and solutions", () => {
    expect(r.questions.map((q) => q.number)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(r.questions.map((q) => q.band)).toEqual(["foundation", "foundation", "challenge", "foundation", "challenge", "achiever"]);
    expect(r.categories.map((c) => c.name)).toEqual(["Part–Whole", "Equivalent Fractions"]);
    expect(r.questions.every((q) => q.solutionHtml)).toBe(true);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
  });
  it("fingerprints are stable and content-sensitive", async () => {
    const css = await sha256Hex(r.css);
    const a = await contentFingerprint(r.questions[0].html, css);
    expect(await contentFingerprint(r.questions[0].html.replace(/\s+/g, "  "), css)).toBe(a);
    expect(await contentFingerprint(r.questions[1].html, css)).not.toBe(a);
  });
});

const q = (id: string, extra: Partial<LibQ> = {}): LibQ => ({
  id, subject_id: "s1", difficulty_code: "foundation", answer_format: "none", created_at: Date.now(), archived_at: null,
  version_id: "v" + id, version_no: 1, qno: id, plain_text: "text " + id, file_name: "f.html", concepts: [], has_key: 0,
  attempt_count: null, graded_count: null, correct_count: null, score_permille_sum: null, total_time_seconds: null,
  last_attempted_at: null, last_time_seconds: null, last_result: null, personal_difficulty_permille: null, familiarity_permille: null, ...extra,
});

describe("filter", () => {
  const lib = [q("1"), q("2", { attempt_count: 2, last_result: "incorrect", last_attempted_at: Date.now() - 40 * 864e5 }), q("3", { difficulty_code: "achiever", concepts: [["c2", 0.5]] })];
  const concepts = [{ id: "c1", subject_id: "s1", parent_id: null, name: "A", archived_at: null, merged_into_id: null }, { id: "c2", subject_id: "s1", parent_id: "c1", name: "B", archived_at: null, merged_into_id: null }];
  it("AND / OR groups", () => {
    const d = emptyFilter();
    d.groups = [{ op: "and", conds: [{ type: "never_attempted" }] }, { op: "and", conds: [{ type: "last_result", results: ["incorrect"] }] }];
    d.op = "or";
    expect(lib.filter(compile(d, concepts)).map((x) => x.id)).toEqual(["1", "2", "3"]);
    d.op = "and";
    expect(lib.filter(compile(d, concepts))).toEqual([]);
  });
  it("concept with sub-concepts and min weight; relative dates", () => {
    const d = emptyFilter();
    d.groups[0].conds = [{ type: "concept", ids: ["c1"], includeSub: true, minWeight: 0.5 }];
    expect(lib.filter(compile(d, concepts)).map((x) => x.id)).toEqual(["3"]);
    d.groups[0].conds = [{ type: "concept", ids: ["c1"], includeSub: false, minWeight: 0 }];
    expect(lib.filter(compile(d, concepts))).toEqual([]);
    d.groups[0].conds = [{ type: "last_attempted", op: "more_than", days: 30 }, { type: "attempt_count", op: ">=", value: 1 }];
    expect(lib.filter(compile(d, concepts)).map((x) => x.id)).toEqual(["2"]);
  });
});

describe("sampler", () => {
  const pool = Array.from({ length: 50 }, (_, i) => q(String(i).padStart(2, "0"), { difficulty_code: i % 2 ? "challenge" : "foundation" }));
  it("same seed → same paper, never repeats, reports shortfall", () => {
    const a = buildPaper(pool, 20, 123, defaultSettings()).picks.map((p) => p.q.id);
    const b = buildPaper([...pool].reverse(), 20, 123, defaultSettings()).picks.map((p) => p.q.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(20);
    expect(buildPaper(pool, 20, 124, defaultSettings()).picks.map((p) => p.q.id)).not.toEqual(a);
    expect(buildPaper(pool, 60, 1, defaultSettings()).shortfall).toBe(10);
  });
  it("honours a difficulty mix", () => {
    const r = buildPaper(pool, 10, 5, { ...defaultSettings(), mix: { foundation: 70, challenge: 30 } });
    expect(r.picks.filter((p) => p.q.difficulty_code === "foundation").length).toBe(7);
  });
});
