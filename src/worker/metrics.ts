// Derived metrics (FR-5, DR-6). The live update after each grade and the full
// rebuild use the SAME SELECT statements, only narrowed by a WHERE clause, so a
// rebuild from history always gives identical numbers.
//
// Algorithms (algo_version 1, integer maths only so results are exact):
//   personal difficulty = (2 * prior + sum(1000 - score)) / (2 + graded), rounded
//                         prior = authored label's rank spread over 0..1000
//                         (Foundation 250, Challenge 500, Achiever 750); 500 if none.
//   familiarity (stored) = 1000 * n / (n + 2), n = attempts. The app fades it with
//                         time since last seen when showing it (FR-5.4).

export const ALGO_VERSION = 1;

const QUESTION_STAT_COLS = `question_id, attempt_count, graded_count, correct_count, incorrect_count,
  partial_count, score_permille_sum, total_time_seconds, last_attempt_id, last_attempted_at,
  last_time_seconds, last_result, personal_difficulty_permille, familiarity_permille, algo_version`;

/** SELECT producing question_stat rows in table column order. `where` filters attempts (alias a). */
export function questionStatSelect(where = "1=1"): string {
  return `
SELECT agg.question_id, agg.attempt_count, agg.graded_count, agg.correct_count, agg.incorrect_count,
  agg.partial_count, agg.score_sum, agg.time_sum, l.id, l.attempted_at, l.time_taken_seconds, l.result,
  (2 * pr.prior + agg.inv_sum + (2 + agg.graded_count) / 2) / (2 + agg.graded_count),
  (1000 * agg.attempt_count) / (agg.attempt_count + 2),
  ${ALGO_VERSION}
FROM (
  SELECT x.question_id,
    count(*) AS attempt_count,
    count(x.result) AS graded_count,
    sum(CASE WHEN x.result = 'correct' THEN 1 ELSE 0 END) AS correct_count,
    sum(CASE WHEN x.result = 'incorrect' THEN 1 ELSE 0 END) AS incorrect_count,
    sum(CASE WHEN x.result = 'partial' THEN 1 ELSE 0 END) AS partial_count,
    sum(CASE WHEN x.result IS NULL THEN 0 ELSE x.score_permille END) AS score_sum,
    sum(CASE WHEN x.result IS NULL THEN 0 ELSE 1000 - x.score_permille END) AS inv_sum,
    sum(x.time_taken_seconds) AS time_sum
  FROM (SELECT a.question_id, a.time_taken_seconds, g.result, g.score_permille
        FROM attempt a LEFT JOIN v_effective_grade g ON g.attempt_id = a.id
        WHERE ${where}) x
  GROUP BY x.question_id
) agg
JOIN (
  SELECT * FROM (
    SELECT a.id, a.question_id, a.attempted_at, a.time_taken_seconds, g.result,
      row_number() OVER (PARTITION BY a.question_id ORDER BY a.attempted_at DESC, a.id DESC) AS rn
    FROM attempt a LEFT JOIN v_effective_grade g ON g.attempt_id = a.id
    WHERE ${where}
  ) WHERE rn = 1
) l ON l.question_id = agg.question_id
JOIN (
  SELECT q.id AS question_id,
    CASE WHEN d.sort_rank IS NULL THEN 500
         ELSE (1000 * d.sort_rank) / ((SELECT max(sort_rank) FROM difficulty) + 1) END AS prior
  FROM question q LEFT JOIN difficulty d ON d.code = q.difficulty_code
) pr ON pr.question_id = agg.question_id`;
}

/** SELECT producing concept_daily_stat rows. `where` filters (aliases a, qc). */
export function conceptDailySelect(where = "1=1"): string {
  return `
SELECT qc.concept_id, a.local_date, count(*),
  sum(CAST(round(qc.weight * 1000) AS INTEGER)),
  sum(CAST(round(qc.weight * 1000) AS INTEGER) * g.score_permille)
FROM attempt a
JOIN v_effective_grade g ON g.attempt_id = a.id
JOIN question_concept qc ON qc.question_id = a.question_id
WHERE ${where}
GROUP BY qc.concept_id, a.local_date`;
}

/** SELECT producing subject_daily_stat rows. `where` filters (aliases a, q). */
export function subjectDailySelect(where = "1=1"): string {
  return `
SELECT q.subject_id, a.local_date, count(*), sum(g.score_permille)
FROM attempt a
JOIN v_effective_grade g ON g.attempt_id = a.id
JOIN question q ON q.id = a.question_id
WHERE q.subject_id IS NOT NULL AND ${where}
GROUP BY q.subject_id, a.local_date`;
}

/** Statements that refresh every metric touched by grades on one question on one day. */
export function liveUpdateStatements(db: D1Database, questionId: string, localDate: string): D1PreparedStatement[] {
  return [
    db.prepare(`INSERT OR REPLACE INTO question_stat (${QUESTION_STAT_COLS}) ${questionStatSelect("a.question_id = ?1")}`)
      .bind(questionId),
    db.prepare(
      `DELETE FROM concept_daily_stat WHERE local_date = ?2
         AND concept_id IN (SELECT concept_id FROM question_concept WHERE question_id = ?1)`,
    ).bind(questionId, localDate),
    db.prepare(
      `INSERT INTO concept_daily_stat ${conceptDailySelect(
        "a.local_date = ?2 AND qc.concept_id IN (SELECT concept_id FROM question_concept WHERE question_id = ?1)",
      )}`,
    ).bind(questionId, localDate),
    db.prepare(
      `DELETE FROM subject_daily_stat WHERE local_date = ?2
         AND subject_id = (SELECT subject_id FROM question WHERE id = ?1)`,
    ).bind(questionId, localDate),
    db.prepare(
      `INSERT INTO subject_daily_stat ${subjectDailySelect(
        "a.local_date = ?2 AND q.subject_id = (SELECT subject_id FROM question WHERE id = ?1)",
      )}`,
    ).bind(questionId, localDate),
  ];
}

/** Recompute one question's stat row (e.g. after its difficulty label changes). */
export function questionStatStatement(db: D1Database, questionId: string): D1PreparedStatement {
  return db
    .prepare(`INSERT OR REPLACE INTO question_stat (${QUESTION_STAT_COLS}) ${questionStatSelect("a.question_id = ?1")}`)
    .bind(questionId);
}

/** Rebuild concept + subject daily stats from history (after tag/subject edits). */
export function rebuildDailyStatements(db: D1Database): D1PreparedStatement[] {
  return [
    db.prepare(`DELETE FROM concept_daily_stat`),
    db.prepare(`INSERT INTO concept_daily_stat ${conceptDailySelect()}`),
    db.prepare(`DELETE FROM subject_daily_stat`),
    db.prepare(`INSERT INTO subject_daily_stat ${subjectDailySelect()}`),
  ];
}

export function rebuildAllStatements(db: D1Database): D1PreparedStatement[] {
  return [
    db.prepare(`DELETE FROM question_stat`),
    db.prepare(`INSERT INTO question_stat (${QUESTION_STAT_COLS}) ${questionStatSelect()}`),
    ...rebuildDailyStatements(db),
  ];
}

/** Count rows that differ between live metrics and a fresh rebuild (DR-6). */
export async function compareMetrics(db: D1Database): Promise<Record<string, number>> {
  const pairs: [string, string][] = [
    ["question_stat", questionStatSelect()],
    ["concept_daily_stat", conceptDailySelect()],
    ["subject_daily_stat", subjectDailySelect()],
  ];
  const stmts = pairs.map(([table, sel]) =>
    db.prepare(
      `SELECT (SELECT count(*) FROM (SELECT * FROM ${table} EXCEPT ${sel}))
            + (SELECT count(*) FROM (${sel} EXCEPT SELECT * FROM ${table})) AS n`,
    ),
  );
  const results = await db.batch<{ n: number }>(stmts);
  const out: Record<string, number> = {};
  pairs.forEach(([table], i) => (out[table] = results[i].results[0]?.n ?? 0));
  return out;
}
