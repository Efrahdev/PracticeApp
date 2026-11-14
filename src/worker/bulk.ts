// Bulk edit of many questions at once (R3/R4): subject, topics (add / replace / remove),
// answer format, custom fields (set / clear), notes, archive / unarchive / delete.
// The same plan gives a preview (counts only) or is applied in ONE all-or-nothing
// D1 batch. Set-based SQL, so 240 questions cost a handful of statements.
// Every change is written to change_log; deleted questions leave a snapshot there.
import { HttpError, json, readJson } from "./http";
import { rebuildDailyStatements } from "./metrics";
import type { Env } from "./api";

export interface BulkSpec {
  ids: string[];
  dry_run?: boolean;
  subject?: { id: string | null };
  topics?: { mode: "add" | "replace" | "remove"; items: { concept_id: string; weight?: number }[] };
  answer_format?: string;
  fields?: { field_id: string; action: "set" | "clear"; value?: string | number | boolean | null }[];
  notes?: { mode: "set" | "append" | "clear"; text?: string };
  status?: "archive" | "unarchive" | "delete";
}

const IDS = `(SELECT value FROM json_each(?1))`;
const FORMATS = ["none", "mcq_single", "mcq_multi", "numeric", "text"];
const LOG = `INSERT INTO change_log (table_name, row_key, column_name, op, old_value, new_value, changed_at)`;

type Count = { key: string; stmt: D1PreparedStatement };

export async function bulkEdit(req: Request, env: Env) {
  const db = env.DB;
  const spec = await readJson<BulkSpec>(req);
  const ids = [...new Set((spec.ids ?? []).filter((x) => typeof x === "string"))];
  if (!ids.length) throw new HttpError(400, "No questions selected.");
  if (ids.length > 5000) throw new HttpError(400, "Select at most 5,000 questions at a time.");
  const idsJson = JSON.stringify(ids);
  const t = Date.now();
  const counts: Count[] = [{ key: "found", stmt: db.prepare(`SELECT count(*) AS n FROM question WHERE id IN ${IDS}`).bind(idsJson) }];
  const mutate: D1PreparedStatement[] = [];
  const fieldNames: Record<string, string> = {};
  let daily = false;

  const editing = !!(spec.subject || spec.topics || spec.answer_format || spec.fields?.length || spec.notes);
  if (spec.status === "delete" && editing) throw new HttpError(400, "Delete cannot be combined with other changes.");

  // ---------- simple columns: subject, answer format, notes, archive
  const column = (key: string, col: string, value: unknown, cond: string, newExpr = "?2") => {
    const countStmt = db.prepare(`SELECT count(*) AS n FROM question WHERE id IN ${IDS} AND ${cond}`);
    counts.push({ key, stmt: cond.includes("?2") ? countStmt.bind(idsJson, value) : countStmt.bind(idsJson) });
    mutate.push(
      db.prepare(`${LOG} SELECT 'question', id, '${col}', 'update', CAST(${col} AS TEXT), CAST(${newExpr} AS TEXT), ?3 FROM question WHERE id IN ${IDS} AND ${cond}`).bind(idsJson, value, t),
      db.prepare(`UPDATE question SET ${col} = ${newExpr} WHERE id IN ${IDS} AND ${cond}`).bind(idsJson, value),
    );
  };

  if (spec.subject) {
    const sid = spec.subject.id || null;
    if (sid && !(await db.prepare(`SELECT 1 FROM subject WHERE id = ?`).bind(sid).first())) throw new HttpError(400, "That subject does not exist.");
    column("subject", "subject_id", sid, "subject_id IS NOT ?2");
    daily = true;
  }
  if (spec.answer_format) {
    if (!FORMATS.includes(spec.answer_format)) throw new HttpError(400, "Unknown answer format.");
    column("answer_format", "answer_format", spec.answer_format, "answer_format IS NOT ?2");
  }
  if (spec.notes) {
    const text = (spec.notes.text ?? "").trim();
    if (spec.notes.mode === "clear") column("notes", "notes", null, "notes IS NOT NULL");
    else if (!text) throw new HttpError(400, "Write the note text first.");
    else if (spec.notes.mode === "set") column("notes", "notes", text, "notes IS NOT ?2");
    else column("notes", "notes", text, "1 = 1", "CASE WHEN notes IS NULL OR notes = '' THEN ?2 ELSE notes || char(10) || ?2 END");
  }
  if (spec.status === "archive") column("archive", "archived_at", t, "archived_at IS NULL");
  if (spec.status === "unarchive") column("unarchive", "archived_at", null, "archived_at IS NOT NULL");

  // ---------- topics
  if (spec.topics) {
    const items = new Map<string, number>();
    for (const it of spec.topics.items ?? []) {
      const w = it.weight === undefined || it.weight === null ? 1 : Number(it.weight);
      if (spec.topics.mode !== "remove" && !(w > 0 && w <= 1)) throw new HttpError(400, "Topic weights must be above 0 and at most 1.");
      items.set(it.concept_id, Math.round(w * 1000) / 1000);
    }
    if (!items.size && spec.topics.mode !== "replace") throw new HttpError(400, "Choose at least one topic.");
    const known = (await db.prepare(`SELECT id FROM concept WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify([...items.keys()])).all<{ id: string }>()).results;
    if (known.length !== items.size) throw new HttpError(400, "A chosen topic does not exist.");
    const topics = JSON.stringify([...items].map(([concept_id, weight]) => ({ concept_id, weight })));
    const P = `(SELECT q.id AS qid, json_extract(c.value,'$.concept_id') AS cid, json_extract(c.value,'$.weight') AS w
                  FROM question q, json_each(?2) c WHERE q.id IN ${IDS})`;
    const NEWSET = `(SELECT json_extract(value,'$.concept_id') FROM json_each(?2))`;
    if (spec.topics.mode === "remove") {
      const cond = `question_id IN ${IDS} AND concept_id IN ${NEWSET}`;
      counts.push({ key: "topics_removed", stmt: db.prepare(`SELECT count(*) AS n FROM question_concept WHERE ${cond}`).bind(idsJson, topics) });
      mutate.push(
        db.prepare(`${LOG} SELECT 'question_concept', question_id || '|' || concept_id, 'weight', 'delete', CAST(weight AS TEXT), NULL, ?3 FROM question_concept WHERE ${cond}`).bind(idsJson, topics, t),
        db.prepare(`DELETE FROM question_concept WHERE ${cond}`).bind(idsJson, topics),
      );
    } else {
      if (spec.topics.mode === "replace") {
        const cond = `question_id IN ${IDS} AND concept_id NOT IN ${NEWSET}`;
        counts.push({ key: "topics_removed", stmt: db.prepare(`SELECT count(*) AS n FROM question_concept WHERE ${cond}`).bind(idsJson, topics) });
        mutate.push(
          db.prepare(`${LOG} SELECT 'question_concept', question_id || '|' || concept_id, 'weight', 'delete', CAST(weight AS TEXT), NULL, ?3 FROM question_concept WHERE ${cond}`).bind(idsJson, topics, t),
        );
      }
      const missing = `NOT EXISTS (SELECT 1 FROM question_concept x WHERE x.question_id = p.qid AND x.concept_id = p.cid)`;
      counts.push(
        { key: "topics_added", stmt: db.prepare(`SELECT count(*) AS n FROM ${P} p WHERE ${missing}`).bind(idsJson, topics) },
        { key: "topics_reweighted", stmt: db.prepare(`SELECT count(*) AS n FROM ${P} p JOIN question_concept x ON x.question_id = p.qid AND x.concept_id = p.cid WHERE x.weight <> p.w`).bind(idsJson, topics) },
      );
      mutate.push(
        db.prepare(`${LOG} SELECT 'question_concept', p.qid || '|' || p.cid, 'weight', 'insert', NULL, CAST(p.w AS TEXT), ?3 FROM ${P} p WHERE ${missing}`).bind(idsJson, topics, t),
        db.prepare(`${LOG} SELECT 'question_concept', p.qid || '|' || p.cid, 'weight', 'update', CAST(x.weight AS TEXT), CAST(p.w AS TEXT), ?3 FROM ${P} p JOIN question_concept x ON x.question_id = p.qid AND x.concept_id = p.cid WHERE x.weight <> p.w`).bind(idsJson, topics, t),
      );
      if (spec.topics.mode === "replace") {
        mutate.push(db.prepare(`DELETE FROM question_concept WHERE question_id IN ${IDS} AND concept_id NOT IN ${NEWSET}`).bind(idsJson, topics));
      }
      mutate.push(
        db.prepare(
          `INSERT INTO question_concept (question_id, concept_id, weight, created_at) SELECT p.qid, p.cid, p.w, ?3 FROM ${P} p WHERE true
           ON CONFLICT(question_id, concept_id) DO UPDATE SET weight = excluded.weight`,
        ).bind(idsJson, topics, t),
      );
    }
    daily = true;
  }

  // ---------- custom fields
  if (spec.fields?.length) {
    const defs = new Map((await db.prepare(`SELECT id, name, data_type FROM custom_field`).all<{ id: string; name: string; data_type: string }>()).results.map((f) => [f.id, f]));
    for (const f of spec.fields) {
      const def = defs.get(f.field_id);
      if (!def) throw new HttpError(400, "Unknown custom field.");
      fieldNames[def.id] = def.name;
      const key = `field:${def.id}`;
      if (f.action === "clear") {
        const cond = `question_id IN ${IDS} AND field_id = ?2`;
        counts.push({ key, stmt: db.prepare(`SELECT count(*) AS n FROM question_field_value WHERE ${cond}`).bind(idsJson, def.id) });
        mutate.push(
          db.prepare(`${LOG} SELECT 'question_field_value', question_id || '|' || field_id, ?3, 'delete',
                        CAST(coalesce(value_text, value_number, value_date, value_bool) AS TEXT), NULL, ?4 FROM question_field_value WHERE ${cond}`).bind(idsJson, def.id, def.name, t),
          db.prepare(`DELETE FROM question_field_value WHERE ${cond}`).bind(idsJson, def.id),
        );
        continue;
      }
      const v = { text: null as string | null, num: null as number | null, date: null as string | null, bool: null as number | null };
      const raw = f.value;
      if (raw === null || raw === undefined || raw === "") throw new HttpError(400, `Give a value for ${def.name}.`);
      if (def.data_type === "number") {
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new HttpError(400, `${def.name} must be a number.`);
        v.num = n;
      } else if (def.data_type === "boolean") v.bool = raw === true || raw === "true" || raw === 1 ? 1 : 0;
      else if (def.data_type === "date") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) throw new HttpError(400, `${def.name} must be a date.`);
        v.date = String(raw);
      } else v.text = String(raw).trim();
      const same = `f.value_text IS ?3 AND f.value_number IS ?4 AND f.value_date IS ?5 AND f.value_bool IS ?6`;
      const from = `question q LEFT JOIN question_field_value f ON f.question_id = q.id AND f.field_id = ?2 WHERE q.id IN ${IDS} AND NOT (f.question_id IS NOT NULL AND ${same})`;
      const newText = `CAST(coalesce(?3, ?4, ?5, ?6) AS TEXT)`;
      counts.push({ key, stmt: db.prepare(`SELECT count(*) AS n FROM ${from}`).bind(idsJson, def.id, v.text, v.num, v.date, v.bool) });
      mutate.push(
        db.prepare(`${LOG} SELECT 'question_field_value', q.id || '|' || ?2, ?7, CASE WHEN f.question_id IS NULL THEN 'insert' ELSE 'update' END,
                      CAST(coalesce(f.value_text, f.value_number, f.value_date, f.value_bool) AS TEXT), ${newText}, ?8 FROM ${from}`)
          .bind(idsJson, def.id, v.text, v.num, v.date, v.bool, def.name, t),
        db.prepare(`INSERT OR REPLACE INTO question_field_value (question_id, field_id, value_text, value_number, value_date, value_bool, updated_at)
                    SELECT q.id, ?2, ?3, ?4, ?5, ?6, ?7 FROM ${from}`).bind(idsJson, def.id, v.text, v.num, v.date, v.bool, t),
      );
    }
  }

  // ---------- delete (questions with attempts or in papers are archived instead: history must stay complete)
  if (spec.status === "delete") {
    const blocked = `(EXISTS (SELECT 1 FROM attempt a WHERE a.question_id = question.id) OR EXISTS (SELECT 1 FROM paper_item p WHERE p.question_id = question.id))`;
    const DEL = `(SELECT id FROM question WHERE id IN ${IDS} AND NOT ${blocked})`;
    const VERS = `(SELECT id FROM question_version WHERE question_id IN ${DEL})`;
    counts.push(
      { key: "delete", stmt: db.prepare(`SELECT count(*) AS n FROM ${DEL}`).bind(idsJson) },
      { key: "archive_instead", stmt: db.prepare(`SELECT count(*) AS n FROM question WHERE id IN ${IDS} AND ${blocked} AND archived_at IS NULL`).bind(idsJson) },
      { key: "kept_with_history", stmt: db.prepare(`SELECT count(*) AS n FROM question WHERE id IN ${IDS} AND ${blocked}`).bind(idsJson) },
    );
    mutate.push(
      db.prepare(`${LOG} SELECT 'question', q.id, '*', 'delete',
                    json_object('external_ref', q.external_ref, 'subject_id', q.subject_id, 'answer_format', q.answer_format,
                                'text', (SELECT plain_text FROM v_question_current c WHERE c.id = q.id)), NULL, ?2
                    FROM question q WHERE q.id IN ${DEL}`).bind(idsJson, t),
      db.prepare(`DELETE FROM answer_key WHERE question_version_id IN ${VERS}`).bind(idsJson),
      db.prepare(`DELETE FROM solution WHERE question_version_id IN ${VERS}`).bind(idsJson),
      db.prepare(`DELETE FROM suggestion WHERE question_id IN ${DEL}`).bind(idsJson),
      db.prepare(`DELETE FROM question_version_asset WHERE question_version_id IN ${VERS}`).bind(idsJson),
      db.prepare(`DELETE FROM question_concept WHERE question_id IN ${DEL}`).bind(idsJson),
      db.prepare(`DELETE FROM question_field_value WHERE question_id IN ${DEL}`).bind(idsJson),
      db.prepare(`DELETE FROM question_stat WHERE question_id IN ${DEL}`).bind(idsJson),
      db.prepare(`DELETE FROM question_version WHERE question_id IN ${DEL}`).bind(idsJson),
      db.prepare(`DELETE FROM question WHERE id IN ${DEL}`).bind(idsJson),
      db.prepare(`${LOG} SELECT 'question', id, 'archived_at', 'update', NULL, CAST(?2 AS TEXT), ?2 FROM question WHERE id IN ${IDS} AND ${blocked} AND archived_at IS NULL`).bind(idsJson, t),
      db.prepare(`UPDATE question SET archived_at = ?2 WHERE id IN ${IDS} AND ${blocked} AND archived_at IS NULL`).bind(idsJson, t),
    );
  }

  if (!editing && !spec.status) throw new HttpError(400, "Choose at least one change.");

  const res = await db.batch<{ n: number }>(counts.map((c) => c.stmt));
  const summary: Record<string, number> = {};
  counts.forEach((c, i) => (summary[c.key] = res[i].results[0]?.n ?? 0));
  const fields = Object.entries(fieldNames).map(([id, name]) => ({ name, n: summary[`field:${id}`] ?? 0 }));
  for (const id of Object.keys(fieldNames)) delete summary[`field:${id}`];

  if (spec.dry_run) return json({ preview: true, summary, fields });
  if (daily) mutate.push(...rebuildDailyStatements(db));
  if (mutate.length) await db.batch(mutate); // all-or-nothing (R4)
  return json({ preview: false, summary, fields });
}
