// Bulk edit of many questions at once:
//   subject (set / clear / new), topics (add / replace / remove / clear all, existing or
//   new topic paths), answer format, marks, custom fields (set / clear / clear all), notes,
//   archive / unarchive — and permanent delete.
// The same plan gives a preview (counts only, nothing saved) or is applied in ONE
// all-or-nothing D1 batch. Set-based SQL: 240 questions cost a handful of statements.
// Every change is written to change_log; deleted questions leave a snapshot there.
import { ulid } from "../shared/ulid";
import { HttpError, json, readJson } from "./http";
import { rebuildAllStatements, rebuildDailyStatements } from "./metrics";
import type { Env } from "./api";

type SubjectRef = { id: string } | { name: string };
type TopicItem = { concept_id?: string; path?: string[]; subject?: SubjectRef; weight?: number };

export interface BulkSpec {
  ids: string[];
  dry_run?: boolean;
  subject?: { id?: string | null; name?: string }; // id null = clear; name = new (or existing by name)
  topics?: { mode: "add" | "replace" | "remove" | "clear"; items?: TopicItem[] };
  answer_format?: string;
  marks?: { value: number | null };
  fields?: { field_id: string; action: "set" | "clear"; value?: string | number | boolean | null }[];
  clear_all_fields?: boolean;
  notes?: { mode: "set" | "append" | "clear"; text?: string };
  status?: "archive" | "unarchive" | "delete";
  remove_empty_imports?: boolean; // with delete: drop imports (and their source files) left with no questions
}

const IDS = `(SELECT value FROM json_each(?1))`;
const FORMATS = ["none", "mcq_single", "mcq_multi", "numeric", "text"];
const LOG = `INSERT INTO change_log (table_name, row_key, column_name, op, old_value, new_value, changed_at)`;
const SHIFT = 1_000_000; // temporary offset while renumbering paper positions

type Count = { key: string; stmt: D1PreparedStatement };
type Row = Record<string, any>;

export async function bulkEdit(req: Request, env: Env) {
  const db = env.DB;
  const spec = await readJson<BulkSpec>(req);
  const ids = [...new Set((spec.ids ?? []).filter((x) => typeof x === "string"))];
  if (!ids.length) throw new HttpError(400, "No questions selected.");
  if (ids.length > 5000) throw new HttpError(400, "Select at most 5,000 questions at a time.");
  const idsJson = JSON.stringify(ids);
  const t = Date.now();
  const counts: Count[] = [{ key: "found", stmt: db.prepare(`SELECT count(*) AS n FROM question WHERE id IN ${IDS}`).bind(idsJson) }];
  const pre: D1PreparedStatement[] = []; // creations (subjects, topics) that edits depend on
  const mutate: D1PreparedStatement[] = [];
  const fieldNames: Record<string, string> = {};
  const created = { subjects: [] as string[], topics: [] as string[] };
  let daily = false;
  let rebuildAll = false;

  const editing = !!(spec.subject || spec.topics || spec.answer_format || spec.marks || spec.fields?.length || spec.clear_all_fields || spec.notes);
  if (spec.status === "delete" && editing) throw new HttpError(400, "Delete cannot be combined with other changes.");
  if (!editing && !spec.status) throw new HttpError(400, "Choose at least one change.");

  // ---------- subjects (resolved once; a new name is created inside the same batch)
  let activeSubjects: Map<string, string> | null = null; // lower(name) → id
  const subjectId = async (ref: SubjectRef): Promise<string> => {
    if ("id" in ref) {
      if (!(await db.prepare(`SELECT 1 FROM subject WHERE id = ?`).bind(ref.id).first())) throw new HttpError(400, "That subject does not exist.");
      return ref.id;
    }
    const name = (ref.name ?? "").trim().slice(0, 120);
    if (!name) throw new HttpError(400, "Type a name for the new subject.");
    if (!activeSubjects) {
      activeSubjects = new Map((await db.prepare(`SELECT id, name FROM subject WHERE archived_at IS NULL`).all<{ id: string; name: string }>()).results.map((s) => [s.name.toLowerCase(), s.id]));
    }
    let id = activeSubjects.get(name.toLowerCase());
    if (!id) {
      id = ulid(t);
      activeSubjects.set(name.toLowerCase(), id);
      created.subjects.push(name);
      pre.push(db.prepare(`INSERT INTO subject (id, name, created_at) VALUES (?,?,?)`).bind(id, name, t));
    }
    return id;
  };

  // ---------- simple columns: subject, answer format, marks, notes, archive
  const column = (key: string, col: string, value: unknown, cond: string, newExpr = "?2") => {
    const countStmt = db.prepare(`SELECT count(*) AS n FROM question WHERE id IN ${IDS} AND ${cond}`);
    counts.push({ key, stmt: cond.includes("?2") ? countStmt.bind(idsJson, value) : countStmt.bind(idsJson) });
    mutate.push(
      db.prepare(`${LOG} SELECT 'question', id, '${col}', 'update', CAST(${col} AS TEXT), CAST(${newExpr} AS TEXT), ?3 FROM question WHERE id IN ${IDS} AND ${cond}`).bind(idsJson, value, t),
      db.prepare(`UPDATE question SET ${col} = ${newExpr} WHERE id IN ${IDS} AND ${cond}`).bind(idsJson, value),
    );
  };

  if (spec.subject) {
    const sid = spec.subject.name?.trim() ? await subjectId({ name: spec.subject.name }) : spec.subject.id ? await subjectId({ id: spec.subject.id }) : null;
    column("subject", "subject_id", sid, "subject_id IS NOT ?2");
    daily = true;
  }
  if (spec.answer_format) {
    if (!FORMATS.includes(spec.answer_format)) throw new HttpError(400, "Unknown answer format.");
    column("answer_format", "answer_format", spec.answer_format, "answer_format IS NOT ?2");
  }
  if (spec.marks) {
    const m = spec.marks.value === null || (spec.marks.value as unknown) === "" ? null : Number(spec.marks.value);
    if (m !== null && !(m >= 0)) throw new HttpError(400, "Marks must be a number of 0 or more.");
    column("marks", "marks", m, "marks IS NOT ?2");
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
    const mode = spec.topics.mode;
    if (mode === "clear") {
      const cond = `question_id IN ${IDS}`;
      counts.push({ key: "topics_removed", stmt: db.prepare(`SELECT count(*) AS n FROM question_concept WHERE ${cond}`).bind(idsJson) });
      mutate.push(
        db.prepare(`${LOG} SELECT 'question_concept', question_id || '|' || concept_id, 'weight', 'delete', CAST(weight AS TEXT), NULL, ?2 FROM question_concept WHERE ${cond}`).bind(idsJson, t),
        db.prepare(`DELETE FROM question_concept WHERE ${cond}`).bind(idsJson),
      );
    } else {
      // resolve every item to a concept id (creating new topic paths under their subject)
      const items = new Map<string, number>();
      let concepts: Map<string, string> | null = null; // subject|parent|lower(name) → id
      const key = (s: string, p: string | null, n: string) => `${s}|${p ?? ""}|${n.toLowerCase()}`;
      for (const it of spec.topics.items ?? []) {
        const w = it.weight === undefined || it.weight === null ? 1 : Number(it.weight);
        if (mode !== "remove" && !(w > 0 && w <= 1)) throw new HttpError(400, "Topic weights must be above 0 and at most 1.");
        let cid = it.concept_id;
        if (!cid) {
          const path = (it.path ?? []).map((x) => String(x).trim()).filter(Boolean);
          if (!path.length) throw new HttpError(400, "A new topic needs a name.");
          if (!it.subject) throw new HttpError(400, "Choose the subject for the new topic.");
          const sid = await subjectId(it.subject);
          if (!concepts) {
            concepts = new Map((await db.prepare(`SELECT id, subject_id, parent_id, name FROM concept WHERE archived_at IS NULL`).all<Row>()).results.map((c) => [key(c.subject_id, c.parent_id, c.name), c.id]));
          }
          let parent: string | null = null;
          for (const name of path) {
            const k = key(sid, parent, name);
            let id = concepts.get(k);
            if (!id) {
              if (mode === "remove") throw new HttpError(400, `There is no topic “${path.join(" › ")}” to remove.`);
              id = ulid(t);
              concepts.set(k, id);
              created.topics.push(path.slice(0, path.indexOf(name) + 1).join(" › "));
              pre.push(db.prepare(`INSERT INTO concept (id, subject_id, parent_id, name, created_at) VALUES (?,?,?,?,?)`).bind(id, sid, parent, name.slice(0, 120), t));
            }
            parent = id;
          }
          cid = parent!;
        } else if (!(await db.prepare(`SELECT 1 FROM concept WHERE id = ?`).bind(cid).first())) {
          throw new HttpError(400, "A chosen topic does not exist.");
        }
        items.set(cid, Math.round(w * 1000) / 1000);
      }
      if (!items.size && mode !== "replace") throw new HttpError(400, "Choose at least one topic.");
      const topics = JSON.stringify([...items].map(([concept_id, weight]) => ({ concept_id, weight })));
      const P = `(SELECT q.id AS qid, json_extract(c.value,'$.concept_id') AS cid, json_extract(c.value,'$.weight') AS w
                    FROM question q, json_each(?2) c WHERE q.id IN ${IDS})`;
      const NEWSET = `(SELECT json_extract(value,'$.concept_id') FROM json_each(?2))`;
      if (mode === "remove") {
        const cond = `question_id IN ${IDS} AND concept_id IN ${NEWSET}`;
        counts.push({ key: "topics_removed", stmt: db.prepare(`SELECT count(*) AS n FROM question_concept WHERE ${cond}`).bind(idsJson, topics) });
        mutate.push(
          db.prepare(`${LOG} SELECT 'question_concept', question_id || '|' || concept_id, 'weight', 'delete', CAST(weight AS TEXT), NULL, ?3 FROM question_concept WHERE ${cond}`).bind(idsJson, topics, t),
          db.prepare(`DELETE FROM question_concept WHERE ${cond}`).bind(idsJson, topics),
        );
      } else {
        if (mode === "replace") {
          const cond = `question_id IN ${IDS} AND concept_id NOT IN ${NEWSET}`;
          counts.push({ key: "topics_removed", stmt: db.prepare(`SELECT count(*) AS n FROM question_concept WHERE ${cond}`).bind(idsJson, topics) });
          mutate.push(db.prepare(`${LOG} SELECT 'question_concept', question_id || '|' || concept_id, 'weight', 'delete', CAST(weight AS TEXT), NULL, ?3 FROM question_concept WHERE ${cond}`).bind(idsJson, topics, t));
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
        if (mode === "replace") mutate.push(db.prepare(`DELETE FROM question_concept WHERE question_id IN ${IDS} AND concept_id NOT IN ${NEWSET}`).bind(idsJson, topics));
        if (items.size) {
          mutate.push(
            db.prepare(
              `INSERT INTO question_concept (question_id, concept_id, weight, created_at) SELECT p.qid, p.cid, p.w, ?3 FROM ${P} p WHERE true
               ON CONFLICT(question_id, concept_id) DO UPDATE SET weight = excluded.weight`,
            ).bind(idsJson, topics, t),
          );
        }
      }
    }
    daily = true;
  }

  // ---------- custom fields
  if (spec.clear_all_fields) {
    const cond = `question_id IN ${IDS}`;
    counts.push({ key: "fields_cleared", stmt: db.prepare(`SELECT count(*) AS n FROM question_field_value WHERE ${cond}`).bind(idsJson) });
    mutate.push(
      db.prepare(`${LOG} SELECT 'question_field_value', v.question_id || '|' || v.field_id, f.name, 'delete',
                    CAST(coalesce(v.value_text, v.value_number, v.value_date, v.value_bool) AS TEXT), NULL, ?2
                    FROM question_field_value v JOIN custom_field f ON f.id = v.field_id WHERE v.${cond}`).bind(idsJson, t),
      db.prepare(`DELETE FROM question_field_value WHERE ${cond}`).bind(idsJson),
    );
  } else if (spec.fields?.length) {
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

  // ---------- permanent delete, including history (attempts, grades, places in papers)
  let deleteInfo: Row | null = null;
  if (spec.status === "delete") {
    const found = (await db.prepare(`SELECT id FROM question WHERE id IN ${IDS}`).bind(idsJson).all<{ id: string }>()).results.map((r) => r.id);
    const del = new Set(found);
    const delJson = JSON.stringify(found);
    const DEL = `(SELECT value FROM json_each(?1))`;
    const VERS = `(SELECT id FROM question_version WHERE question_id IN ${DEL})`;

    // papers that lose questions: renumber what remains; papers left empty are archived
    const items = (await db.prepare(
      `SELECT paper_id, position, question_id FROM paper_item WHERE paper_id IN (SELECT DISTINCT paper_id FROM paper_item WHERE question_id IN ${DEL}) ORDER BY paper_id, position`,
    ).bind(delJson).all<Row>()).results;
    const byPaper = new Map<string, Row[]>();
    for (const it of items) byPaper.set(it.paper_id, [...(byPaper.get(it.paper_id) ?? []), it]);
    const posMap: { p: string; o: number; n: number }[] = [];
    const emptied: string[] = [];
    const remainingCount = new Map<string, number>();
    const oldToNew = new Map<string, Map<number, number>>();
    for (const [paper, list] of byPaper) {
      const keep = list.filter((it) => !del.has(it.question_id));
      remainingCount.set(paper, keep.length);
      if (!keep.length) emptied.push(paper);
      const m = new Map<number, number>();
      keep.forEach((it, i) => {
        posMap.push({ p: paper, o: it.position, n: i + 1 });
        m.set(it.position, i + 1);
      });
      oldToNew.set(paper, m);
    }
    const sessions = byPaper.size
      ? (await db.prepare(`SELECT id, paper_id, current_position, completed_at FROM practice_session WHERE paper_id IN (SELECT value FROM json_each(?))`)
          .bind(JSON.stringify([...byPaper.keys()])).all<Row>()).results
      : [];
    const sessionMap = sessions.map((s) => {
      const m = oldToNew.get(s.paper_id)!;
      const before = [...m.keys()].filter((o) => o < s.current_position).length;
      const total = remainingCount.get(s.paper_id) ?? 0;
      return { id: s.id, pos: Math.max(1, Math.min(total || 1, before + 1)), done: total === 0 && !s.completed_at };
    });

    // imports that may be left empty
    const batches = (await db.prepare(`SELECT DISTINCT v.import_batch_id AS b, ib.source_file_id AS sf FROM question_version v JOIN import_batch ib ON ib.id = v.import_batch_id WHERE v.question_id IN ${DEL}`)
      .bind(delJson).all<Row>()).results;

    counts.push(
      { key: "delete", stmt: db.prepare(`SELECT count(*) AS n FROM question WHERE id IN ${DEL}`).bind(delJson) },
      { key: "attempts_deleted", stmt: db.prepare(`SELECT count(*) AS n FROM attempt WHERE question_id IN ${DEL}`).bind(delJson) },
      { key: "paper_slots_removed", stmt: db.prepare(`SELECT count(*) AS n FROM paper_item WHERE question_id IN ${DEL}`).bind(delJson) },
      {
        key: "imports_removed",
        stmt: db.prepare(
          `SELECT count(*) AS n FROM import_batch b WHERE b.id IN (SELECT DISTINCT import_batch_id FROM question_version WHERE question_id IN ${DEL})
             AND NOT EXISTS (SELECT 1 FROM question_version v WHERE v.import_batch_id = b.id AND v.question_id NOT IN ${DEL}) AND ?2 = 1`,
        ).bind(delJson, spec.remove_empty_imports ? 1 : 0),
      },
    );
    deleteInfo = { papers_changed: byPaper.size, papers_emptied: emptied.length };

    mutate.push(
      db.prepare(`${LOG} SELECT 'question', q.id, '*', 'delete',
                    json_object('external_ref', q.external_ref, 'subject_id', q.subject_id, 'answer_format', q.answer_format, 'marks', q.marks,
                                'text', (SELECT plain_text FROM v_question_current c WHERE c.id = q.id),
                                'attempts', (SELECT count(*) FROM attempt a WHERE a.question_id = q.id)), NULL, ?2
                    FROM question q WHERE q.id IN ${DEL}`).bind(delJson, t),
      db.prepare(`DELETE FROM question_stat WHERE question_id IN ${DEL}`).bind(delJson), // points at attempts
      db.prepare(`DELETE FROM grade WHERE attempt_id IN (SELECT id FROM attempt WHERE question_id IN ${DEL})`).bind(delJson),
      db.prepare(`DELETE FROM attempt WHERE question_id IN ${DEL}`).bind(delJson),
      db.prepare(`DELETE FROM paper_item WHERE question_id IN ${DEL}`).bind(delJson),
    );
    if (byPaper.size) {
      const papers = JSON.stringify([...byPaper.keys()]);
      const map = JSON.stringify(posMap);
      const lookup = (col: string, table: string) =>
        `(SELECT json_extract(m.value,'$.n') FROM json_each(?2) m WHERE json_extract(m.value,'$.p') = ${table}.paper_id AND json_extract(m.value,'$.o') = ${table}.${col} - ${SHIFT})`;
      mutate.push(
        db.prepare(`UPDATE paper_item SET position = position + ${SHIFT} WHERE paper_id IN (SELECT value FROM json_each(?1))`).bind(papers),
        db.prepare(`UPDATE paper_item SET position = ${lookup("position", "paper_item")} WHERE paper_id IN (SELECT value FROM json_each(?1))`).bind(papers, map),
        db.prepare(`UPDATE attempt SET paper_position = paper_position + ${SHIFT} WHERE paper_id IN (SELECT value FROM json_each(?1)) AND paper_position IS NOT NULL`).bind(papers),
        db.prepare(`UPDATE attempt SET paper_position = ${lookup("paper_position", "attempt")} WHERE paper_id IN (SELECT value FROM json_each(?1)) AND paper_position IS NOT NULL`).bind(papers, map),
      );
      if (sessionMap.length) {
        mutate.push(
          db.prepare(
            `UPDATE practice_session SET
               current_position = (SELECT json_extract(value,'$.pos') FROM json_each(?1) WHERE json_extract(value,'$.id') = practice_session.id),
               completed_at = CASE WHEN (SELECT json_extract(value,'$.done') FROM json_each(?1) WHERE json_extract(value,'$.id') = practice_session.id) THEN ?2 ELSE completed_at END,
               updated_at = ?2
             WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?1))`,
          ).bind(JSON.stringify(sessionMap), t),
        );
      }
      if (emptied.length) {
        mutate.push(db.prepare(`UPDATE paper SET archived_at = ?2 WHERE id IN (SELECT value FROM json_each(?1)) AND archived_at IS NULL`).bind(JSON.stringify(emptied), t));
      }
    }
    mutate.push(
      db.prepare(`DELETE FROM answer_key WHERE question_version_id IN ${VERS}`).bind(delJson),
      db.prepare(`DELETE FROM solution WHERE question_version_id IN ${VERS}`).bind(delJson),
      db.prepare(`DELETE FROM suggestion WHERE question_id IN ${DEL}`).bind(delJson),
      db.prepare(`DELETE FROM question_version_asset WHERE question_version_id IN ${VERS}`).bind(delJson),
      db.prepare(`DELETE FROM question_concept WHERE question_id IN ${DEL}`).bind(delJson),
      db.prepare(`DELETE FROM question_field_value WHERE question_id IN ${DEL}`).bind(delJson),
      db.prepare(`DELETE FROM question_version WHERE question_id IN ${DEL}`).bind(delJson),
      db.prepare(`DELETE FROM question WHERE id IN ${DEL}`).bind(delJson),
    );
    if (spec.remove_empty_imports && batches.length) {
      const b = JSON.stringify([...new Set(batches.map((x) => x.b))]);
      const sf = JSON.stringify([...new Set(batches.map((x) => x.sf))]);
      mutate.push(
        db.prepare(`${LOG} SELECT 'import_batch', id, '*', 'delete', coalesce(label, ''), NULL, ?2 FROM import_batch
                      WHERE id IN (SELECT value FROM json_each(?1)) AND NOT EXISTS (SELECT 1 FROM question_version v WHERE v.import_batch_id = import_batch.id)`).bind(b, t),
        db.prepare(`DELETE FROM import_batch WHERE id IN (SELECT value FROM json_each(?1)) AND NOT EXISTS (SELECT 1 FROM question_version v WHERE v.import_batch_id = import_batch.id)`).bind(b),
        db.prepare(`DELETE FROM source_file WHERE id IN (SELECT value FROM json_each(?1)) AND NOT EXISTS (SELECT 1 FROM import_batch x WHERE x.source_file_id = source_file.id)`).bind(sf),
      );
    }
    rebuildAll = true;
  }

  const res = await db.batch<{ n: number }>(counts.map((c) => c.stmt));
  const summary: Record<string, number> = {};
  counts.forEach((c, i) => (summary[c.key] = res[i].results[0]?.n ?? 0));
  const fields = Object.entries(fieldNames).map(([id, name]) => ({ name, n: summary[`field:${id}`] ?? 0 }));
  for (const id of Object.keys(fieldNames)) delete summary[`field:${id}`];
  if (deleteInfo) Object.assign(summary, deleteInfo);

  if (spec.dry_run) return json({ preview: true, summary, fields, created });
  if (rebuildAll) mutate.push(...rebuildAllStatements(db));
  else if (daily) mutate.push(...rebuildDailyStatements(db));
  // links are checked once, when the whole batch commits
  const all = [...(spec.status === "delete" ? [db.prepare(`PRAGMA defer_foreign_keys = on`)] : []), ...pre, ...mutate];
  if (all.length) await db.batch(all); // all-or-nothing
  return json({ preview: false, summary, fields, created });
}

/** Remove an import from the history once none of its questions remain. */
export async function importRemove(env: Env, batchId: string) {
  const db = env.DB;
  const b = await db.prepare(`SELECT id, source_file_id, label FROM import_batch WHERE id = ?`).bind(batchId).first<Row>();
  if (!b) throw new HttpError(404, "Import not found.");
  const left = await db.prepare(`SELECT count(*) AS n FROM question_version WHERE import_batch_id = ?`).bind(batchId).first<{ n: number }>();
  if ((left?.n ?? 0) > 0) throw new HttpError(409, "This import still has questions. Delete them first (Delete on the import row).");
  const t = Date.now();
  await db.batch([
    db.prepare(`${LOG} VALUES ('import_batch', ?, '*', 'delete', ?, NULL, ?)`).bind(batchId, b.label ?? "", t),
    db.prepare(`DELETE FROM import_batch WHERE id = ?`).bind(batchId),
    db.prepare(`DELETE FROM source_file WHERE id = ? AND NOT EXISTS (SELECT 1 FROM import_batch x WHERE x.source_file_id = source_file.id)`).bind(b.source_file_id),
  ]);
  return json({ ok: true });
}
