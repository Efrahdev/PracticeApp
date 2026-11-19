// Going back and changing an answer (Practice → "Change answer"). Runs the real Worker handlers against the real
// schema (tests/d1.ts) and checks that a changed answer is re-marked on the SAME attempt — never counted twice —
// that every metric still equals a rebuild from history, and that each change is written to change_log.
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../src/worker/api";
import { compareMetrics, rebuildAllStatements } from "../src/worker/metrics";
import { firstUnanswered, inputValueOf, responseFromRow, responseLabel, responseOf, sameResponse } from "../src/client/answers";
import { makeD1 } from "./d1";

const DAY = "2026-11-18";
let raw: ReturnType<typeof makeD1>["raw"];
let env: api.Env;

const req = (body: unknown) => new Request("http://x/", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const body = async (r: Response | Promise<Response>) => (await r).json() as Promise<any>;
const q = (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).all(...args).map((r) => ({ ...r })) as any[];
const one = (sql: string, ...args: (string | number | null)[]) => q(sql, ...args)[0];
async function status(p: Promise<unknown>): Promise<number> {
  try { await p; return 200; } catch (e) { return (e as { status?: number }).status ?? 500; }
}
const counts = () => one(`SELECT (SELECT count(*) FROM attempt) a, (SELECT count(*) FROM grade) g, (SELECT count(*) FROM change_log) c,
  (SELECT group_concat(question_id || ':' || attempt_count || ':' || score_permille_sum, ',') FROM question_stat) s`);

/** Questions: q1–q3 single-choice (key B), q4 multi-choice (key A+C), q5 numeric (key 2.5 ± 0.01), q6 text (no key), q7 worked on paper. */
function seed() {
  const t = 1_700_000_000_000;
  raw.exec(`
    INSERT INTO blob VALUES ('b0', 1, 'text/html', ${t});
    INSERT INTO source_file VALUES ('sf', 'b0', 'f.html', ${t});
    INSERT INTO import_batch (id, source_file_id, parser_version, found_count, new_count, new_version_count, duplicate_count, rejected_count, committed_at)
      VALUES ('ib', 'sf', 't', 7, 7, 0, 0, 0, ${t});
    INSERT INTO subject VALUES ('s1', 'Maths', ${t}, NULL);
    INSERT INTO concept (id, subject_id, parent_id, name, created_at) VALUES ('c1', 's1', NULL, 'Fractions', ${t}), ('c2', 's1', NULL, 'Shapes', ${t});
  `);
  const fmt: Record<string, string> = { q1: "mcq_single", q2: "mcq_single", q3: "mcq_single", q4: "mcq_multi", q5: "numeric", q6: "text", q7: "none" };
  Object.entries(fmt).forEach(([id, f], i) => {
    raw.prepare(`INSERT INTO question (id, subject_id, difficulty_code, answer_format, option_labels, created_at) VALUES (?, 's1', 'foundation', ?, ?, ?)`)
      .run(id, f, f.startsWith("mcq") ? '["A","B","C","D"]' : null, t);
    raw.prepare(`INSERT INTO question_version (id, question_id, version_no, content_sha256, html_blob_sha256, plain_text, import_batch_id, source_position, source_question_number, created_at)
      VALUES (?, ?, 1, ?, 'b0', 'text', 'ib', ?, ?, ?)`).run(`v${id}`, id, `h${id}`, i + 1, String(i + 1), t);
    raw.prepare(`INSERT INTO question_concept VALUES (?, ?, ?, ?)`).run(id, i % 2 ? "c2" : "c1", i === 0 ? 0.5 : 1, t);
  });
  for (const id of ["q1", "q2", "q3"]) raw.prepare(`INSERT INTO answer_key (id, question_version_id, key_no, answer_type, mcq_correct, origin, created_at) VALUES (?, ?, 1, 'mcq_single', '["B"]', 'import', ?)`).run(`k${id}`, `v${id}`, t);
  raw.prepare(`INSERT INTO answer_key (id, question_version_id, key_no, answer_type, mcq_correct, origin, created_at) VALUES ('kq4', 'vq4', 1, 'mcq_multi', '["A","C"]', 'import', ?)`).run(t);
  raw.prepare(`INSERT INTO answer_key (id, question_version_id, key_no, answer_type, numeric_value, numeric_tolerance, origin, created_at) VALUES ('kq5', 'vq5', 1, 'numeric', 2.5, 0.01, 'import', ?)`).run(t);
  raw.exec(`INSERT INTO paper (id, name, filter_definition, sampling_settings, seed, generator_version, requested_count, created_at, frozen_at)
    VALUES ('p1', 'Paper', '{}', '{}', 1, 1, 3, ${t}, ${t})`);
  ["q1", "q2", "q3"].forEach((id, i) => raw.prepare(`INSERT INTO paper_item (paper_id, position, question_id, question_version_id) VALUES ('p1', ?, ?, ?)`).run(i + 1, id, `v${id}`));
}

async function startSitting(): Promise<string> {
  return (await body(api.sessionStart(env, "p1"))).session.id;
}
async function answer(qid: string, response: unknown, extra: Record<string, unknown> = {}) {
  return body(api.attemptCreate(req({ question_id: qid, question_version_id: `v${qid}`, local_date: DAY, time_taken_seconds: 30, response, ...extra }), env));
}
const change = (attemptId: string, b: unknown) => body(api.attemptResponseChange(req(b), env, attemptId));
const metricsMatchRebuild = async () => expect(await compareMetrics(env.DB)).toEqual({ question_stat: 0, concept_daily_stat: 0, subject_daily_stat: 0 });

beforeEach(() => {
  const made = makeD1();
  raw = made.raw;
  env = { DB: made.d1 } as api.Env;
  seed();
});

describe("change an answer: counted once, re-marked, logged", () => {
  it("re-marks the same attempt: no second attempt, metrics move from wrong to right", async () => {
    const sid = await startSitting();
    const a = await answer("q1", { kind: "mcq", options: ["A"] }, { session_id: sid, paper_position: 1 });
    expect(a.grade.result).toBe("incorrect");
    expect(one(`SELECT * FROM question_stat WHERE question_id = 'q1'`)).toMatchObject({ attempt_count: 1, incorrect_count: 1, correct_count: 0, last_result: "incorrect" });

    const r = await change(a.attempt_id, { response: { kind: "mcq", options: ["B"] }, extra_seconds: 7 });
    expect(r.grade).toMatchObject({ result: "correct", score_permille: 1000, method: "auto", rule: "mcq_exact_v1" });
    expect(r.answer_key.id).toBe("kq1");

    // still one attempt, now holding the new answer and the extra time
    expect(q(`SELECT * FROM attempt`)).toHaveLength(1);
    expect(one(`SELECT response_options, time_taken_seconds, local_date, session_id, paper_position FROM attempt`))
      .toEqual({ response_options: '["B"]', time_taken_seconds: 37, local_date: DAY, session_id: sid, paper_position: 1 });
    // the first grade is kept as history; the new one is a correction that counts
    expect(q(`SELECT grade_no, cause, result, method, answer_key_id FROM grade ORDER BY grade_no`)).toEqual([
      { grade_no: 1, cause: "initial", result: "incorrect", method: "auto", answer_key_id: "kq1" },
      { grade_no: 2, cause: "correction", result: "correct", method: "auto", answer_key_id: "kq1" },
    ]);
    expect(one(`SELECT * FROM question_stat WHERE question_id = 'q1'`)).toMatchObject({
      attempt_count: 1, graded_count: 1, correct_count: 1, incorrect_count: 0, score_permille_sum: 1000, total_time_seconds: 37, last_result: "correct",
    });
    // concept weight 0.5 → weight 500; one attempt on the day, full marks
    expect(q(`SELECT * FROM concept_daily_stat`)).toEqual([{ concept_id: "c1", local_date: DAY, graded_count: 1, weight_sum: 500, score_weight_sum: 500_000 }]);
    expect(q(`SELECT * FROM subject_daily_stat`)).toEqual([{ subject_id: "s1", local_date: DAY, graded_count: 1, score_permille_sum: 1000 }]);
    await metricsMatchRebuild();
  });

  it("writes each changed column to change_log, old → new", async () => {
    const a = await answer("q1", { kind: "mcq", options: ["C"] });
    await change(a.attempt_id, { response: { kind: "mcq", options: ["B"] }, extra_seconds: 5 });
    expect(q(`SELECT table_name, row_key, column_name, op, old_value, new_value FROM change_log ORDER BY id`)).toEqual([
      { table_name: "attempt", row_key: a.attempt_id, column_name: "response_options", op: "update", old_value: '["C"]', new_value: '["B"]' },
      { table_name: "attempt", row_key: a.attempt_id, column_name: "time_taken_seconds", op: "update", old_value: "30", new_value: "35" },
    ]);
  });

  it("changing back and forth any number of times still counts one attempt and matches a rebuild", async () => {
    const a = await answer("q2", { kind: "mcq", options: ["A"] });
    for (const o of ["B", "D", "B", "C", "B"]) await change(a.attempt_id, { response: { kind: "mcq", options: [o] } });
    expect(one(`SELECT attempt_count, correct_count, incorrect_count, last_result FROM question_stat WHERE question_id = 'q2'`))
      .toEqual({ attempt_count: 1, correct_count: 1, incorrect_count: 0, last_result: "correct" });
    expect(one(`SELECT max(grade_no) n, count(*) c FROM grade`)).toEqual({ n: 6, c: 6 });
    expect(one(`SELECT result FROM v_effective_grade`)).toEqual({ result: "correct" });
    await metricsMatchRebuild();
    // and a full rebuild from history leaves every row exactly as the live update did
    const before = q(`SELECT * FROM question_stat`);
    await env.DB.batch(rebuildAllStatements(env.DB));
    expect(q(`SELECT * FROM question_stat`)).toEqual(before);
  });

  it("other attempts at the same question are untouched", async () => {
    const first = await answer("q1", { kind: "mcq", options: ["B"] });
    const second = await answer("q1", { kind: "mcq", options: ["A"] });
    await change(second.attempt_id, { response: { kind: "mcq", options: ["B"] } });
    expect(one(`SELECT attempt_count, correct_count FROM question_stat WHERE question_id = 'q1'`)).toEqual({ attempt_count: 2, correct_count: 2 });
    expect(q(`SELECT attempt_id FROM grade WHERE attempt_id = ?`, first.attempt_id)).toHaveLength(1);
    await metricsMatchRebuild();
  });

  it("multi-choice compares options in any order; numeric uses the key's tolerance", async () => {
    const m = await answer("q4", { kind: "mcq", options: ["A"] });
    expect((await change(m.attempt_id, { response: { kind: "mcq", options: ["C", "A"] } })).grade.result).toBe("correct");
    const n = await answer("q5", { kind: "numeric", numeric: 2.7 });
    expect(n.grade.result).toBe("incorrect");
    expect((await change(n.attempt_id, { response: { kind: "numeric", numeric: 2.505 } })).grade.result).toBe("correct");
    expect(one(`SELECT response_numeric FROM attempt WHERE id = ?`, n.attempt_id)).toEqual({ response_numeric: 2.505 });
    await metricsMatchRebuild();
  });

  it("a question without a key needs a grade for the new answer", async () => {
    const a = await answer("q6", { kind: "text", text: "tree" }, { grade: { result: "incorrect" } });
    const before = counts();
    expect(await status(api.attemptResponseChange(req({ response: { kind: "text", text: "three" } }), env, a.attempt_id))).toBe(400);
    expect(counts()).toEqual(before);
    const r = await change(a.attempt_id, { response: { kind: "text", text: "three" }, grade: { result: "partial", score_permille: 600 } });
    expect(r.grade).toMatchObject({ result: "partial", score_permille: 600, method: "manual" });
    expect(one(`SELECT response_text FROM attempt`)).toEqual({ response_text: "three" });
    expect(one(`SELECT partial_count, score_permille_sum FROM question_stat WHERE question_id = 'q6'`)).toEqual({ partial_count: 1, score_permille_sum: 600 });
    await metricsMatchRebuild();
  });

  it("works after the sitting has finished, and does not move the sitting", async () => {
    const sid = await startSitting();
    const a1 = await answer("q1", { kind: "mcq", options: ["A"] }, { session_id: sid, paper_position: 1 });
    await answer("q2", { kind: "mcq", options: ["B"] }, { session_id: sid, paper_position: 2 });
    await answer("q3", { kind: "mcq", options: ["B"] }, { session_id: sid, paper_position: 3 }); // last one finishes the sitting
    const s = one(`SELECT current_position, completed_at, updated_at FROM practice_session`);
    expect(s.completed_at).not.toBeNull();
    await change(a1.attempt_id, { response: { kind: "mcq", options: ["B"] } });
    expect(one(`SELECT current_position, completed_at, updated_at FROM practice_session`)).toEqual(s);
    // the paper's summary reads the effective grade: all three now correct
    const d = await body(api.paperDetail(env, "p1"));
    expect(d.attempts.map((x: any) => x.result)).toEqual(["correct", "correct", "correct"]);
    await metricsMatchRebuild();
  });

  it("an answer changed on a later day stays on the day it was given", async () => {
    const a = await answer("q1", { kind: "mcq", options: ["A"] });
    await change(a.attempt_id, { response: { kind: "mcq", options: ["B"] }, local_date: "2026-11-19" });
    expect(q(`SELECT local_date FROM subject_daily_stat`)).toEqual([{ local_date: DAY }]);
    expect(one(`SELECT local_date FROM attempt`)).toEqual({ local_date: DAY });
  });

  it("Undo this attempt after a change removes it all, and Undo of that puts back the changed answer exactly", async () => {
    const a = await answer("q1", { kind: "mcq", options: ["A"] });
    await change(a.attempt_id, { response: { kind: "mcq", options: ["B"] } });
    const kept = { att: q(`SELECT * FROM attempt`), gr: q(`SELECT * FROM grade ORDER BY grade_no`), st: q(`SELECT * FROM question_stat`) };
    const del = await body(api.attemptsDelete(req({ ids: [a.attempt_id] }), env));
    expect(one(`SELECT count(*) n FROM grade`)).toEqual({ n: 0 });
    expect(q(`SELECT * FROM question_stat`)).toEqual([]);
    await metricsMatchRebuild();
    await body(api.attemptsRestore(req({ payload: del.payload }), env));
    expect(q(`SELECT * FROM attempt`)).toEqual(kept.att);
    expect(q(`SELECT * FROM grade ORDER BY grade_no`)).toEqual(kept.gr);
    expect(q(`SELECT * FROM question_stat`)).toEqual(kept.st);
    await metricsMatchRebuild();
  });

  it("refuses anything that isn't a real change, and writes nothing when it refuses", async () => {
    const a = await answer("q1", { kind: "mcq", options: ["A"] });
    const t = await answer("q7", { kind: "none" }, { grade: { result: "correct" } });
    const before = counts();
    const bad: [string, unknown][] = [
      [a.attempt_id, { response: { kind: "mcq", options: ["A"] } }], // same answer
      [a.attempt_id, { response: { kind: "mcq", options: ["E"] } }], // not an option
      [a.attempt_id, { response: { kind: "mcq", options: ["A", "B"] } }], // two answers to a single-choice question
      [a.attempt_id, { response: { kind: "mcq", options: [] } }],
      [a.attempt_id, { response: { kind: "numeric", numeric: 1 } }], // wrong kind for the question
      [a.attempt_id, { response: { kind: "none" } }],
      [a.attempt_id, {}],
      [t.attempt_id, { response: { kind: "text", text: "x" }, grade: { result: "correct" } }], // worked on paper: use Correct grade
    ];
    for (const [id, b] of bad) expect(await status(api.attemptResponseChange(req(b), env, id))).toBe(400);
    expect(await status(api.attemptResponseChange(req({ response: { kind: "mcq", options: ["B"] } }), env, "nope"))).toBe(404);
    expect(counts()).toEqual(before);
  });

  it("shows an earlier answer with its effective grade and key (for going back after a pause)", async () => {
    const a = await answer("q1", { kind: "mcq", options: ["A"] });
    await change(a.attempt_id, { response: { kind: "mcq", options: ["B"] } });
    const d = await body(api.attemptDetail(env, a.attempt_id));
    expect(d.attempt).toMatchObject({ id: a.attempt_id, response_options: '["B"]', result: "correct", grade_no: 2 });
    expect(d.answer_key.id).toBe("kq1");
    expect(await status(api.attemptDetail(env, "nope"))).toBe(404);
  });
});

describe("answering in a sitting is unchanged", () => {
  it("one attempt per question per sitting, and the sitting moves on as before", async () => {
    const sid = await startSitting();
    await answer("q1", { kind: "mcq", options: ["B"] }, { session_id: sid, paper_position: 1 });
    expect(one(`SELECT current_position, completed_at FROM practice_session`)).toEqual({ current_position: 2, completed_at: null });
    expect(await status(api.attemptCreate(req({ question_id: "q1", question_version_id: "vq1", local_date: DAY, time_taken_seconds: 1,
      response: { kind: "mcq", options: ["A"] }, session_id: sid, paper_position: 1 }), env))).toBe(409);
    expect(one(`SELECT count(*) n FROM attempt`)).toEqual({ n: 1 });
  });
});

describe("answer helpers used by the practice screen", () => {
  const mcq = { answer_format: "mcq_single" }, num = { answer_format: "numeric" }, txt = { answer_format: "text" };
  it("a saved answer goes back into the answer box and out again unchanged", () => {
    for (const [item, v] of [[mcq, ["B"]], [{ answer_format: "mcq_multi" }, ["A", "C"]], [num, "2.5"], [txt, "three"]] as const) {
      const r = responseOf(item, v);
      expect(responseOf(item, inputValueOf(r))).toEqual(r);
    }
    expect(responseOf(num, "5/8")).toEqual({ kind: "numeric", numeric: 0.625 });
    expect(responseOf(mcq, [])).toEqual({ kind: "none" });
    expect(responseOf(txt, "  ")).toEqual({ kind: "none" });
  });
  it("reads attempt rows the way they are stored", () => {
    expect(responseFromRow({ response_kind: "mcq", response_options: '["A","C"]' })).toEqual({ kind: "mcq", options: ["A", "C"], numeric: null, text: null });
    expect(responseFromRow({ response_kind: "numeric", response_numeric: 2.5 })).toEqual({ kind: "numeric", options: null, numeric: 2.5, text: null });
    expect(responseLabel(responseFromRow({ response_kind: "mcq", response_options: '["A","C"]' }))).toBe("A, C");
  });
  it("same answer ignores option order", () => {
    expect(sameResponse({ kind: "mcq", options: ["C", "A"] }, { kind: "mcq", options: ["A", "C"] })).toBe(true);
    expect(sameResponse({ kind: "mcq", options: ["A"] }, { kind: "mcq", options: ["B"] })).toBe(false);
    expect(sameResponse({ kind: "numeric", numeric: 0.625 }, { kind: "numeric", numeric: 0.625 })).toBe(true);
  });
  it("finds where to resume: the first question without an answer", () => {
    const items = [{ position: 3 }, { position: 1 }, { position: 2 }];
    expect(firstUnanswered(items, {})).toBe(1);
    expect(firstUnanswered(items, { 1: {}, 3: {} })).toBe(2);
    expect(firstUnanswered(items, { 1: {}, 2: {}, 3: {} })).toBeNull();
  });
});
