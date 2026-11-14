// Import of canonical question packs (practice-app/question-pack@1).
// The browser parses, validates and normalises the pack, uploads every file by its
// fingerprint, then sends one commit per batch. The Worker classifies each question
// (new / new version / already in library), creates subjects, topics, difficulty labels
// and custom fields as needed, and saves everything in ONE all-or-nothing D1 batch (DR-4).
import { ulid } from "../shared/ulid";
import { HttpError, json, readJson, need, SHA_RE } from "./http";
import type { Env } from "./api";

type Row = Record<string, unknown>;

export interface CommitKey {
  answer_type: "mcq_single" | "mcq_multi" | "numeric" | "text";
  mcq_correct?: string[];
  numeric_value?: number;
  numeric_tolerance?: number;
  text_value?: string;
  origin: "import" | "suggestion";
}

export interface CommitQuestion {
  position: number;
  ref: string;
  number: string;
  content_sha256: string;
  blob_sha256: string;
  plain_text: string;
  answer_format: "none" | "mcq_single" | "mcq_multi" | "numeric" | "text";
  option_labels: string[] | null;
  marks: number | null;
  subject: { id?: string; name?: string } | null;
  topics: { path: string[]; weight: number }[];
  difficulty_code: string | null;
  fields: { name: string; type: "text" | "number" | "date" | "boolean"; value: string | number | boolean }[];
  notes: string | null;
  key: CommitKey | null;
  solution: { format: "markdown" | "html"; body: string; origin: "import" | "suggestion" } | null;
  assets: { ref: string; blob_sha256: string | null; role: "image" | "font" | "stylesheet" | "other" }[];
  decision: "accept" | "reject" | "as_new";
}

interface CommitBody {
  source: { sha256: string; name: string };
  label?: string | null;
  parser_version: string;
  update_existing: boolean;
  new_difficulties: { code: string; label: string }[];
  questions: CommitQuestion[];
}

const jx = (cols: string[]) => cols.map((c) => `json_extract(value,'$.${c}')`).join(", ");

async function all<T = Row>(db: D1Database, sql: string, ...args: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...args).all<T>()).results;
}

type Status =
  | { status: "new" }
  | { status: "new_version"; question_id: string; next_version: number; current_blob_sha256: string; current_format: string; current_css: string | null }
  | { status: "duplicate"; question_id: string; version_id: string; is_current: boolean }
  | { status: "duplicate_in_file"; same_as: number };

async function classify(db: D1Database, qs: { ref: string; content_sha256: string; as_new?: boolean }[]): Promise<Status[]> {
  const byContent = new Map(
    (await all<{ content_sha256: string; question_id: string; version_id: string; is_current: number }>(
      db,
      `SELECT v.content_sha256, v.question_id, v.id AS version_id,
              v.version_no = (SELECT max(version_no) FROM question_version WHERE question_id = v.question_id) AS is_current
         FROM question_version v WHERE v.content_sha256 IN (SELECT value FROM json_each(?))`,
      JSON.stringify(qs.map((q) => q.content_sha256)),
    )).map((r) => [r.content_sha256, r]),
  );
  const byRef = new Map(
    (await all<{ id: string; external_ref: string; max_v: number; blob: string; fmt: string; css: string | null }>(
      db,
      `SELECT c.id, c.external_ref, c.version_no AS max_v, c.html_blob_sha256 AS blob, c.content_format AS fmt,
              (SELECT blob_sha256 FROM question_version_asset WHERE question_version_id = c.version_id AND role = 'stylesheet' LIMIT 1) AS css
         FROM v_question_current c WHERE c.external_ref IN (SELECT value FROM json_each(?))`,
      JSON.stringify(qs.map((q) => q.ref)),
    )).map((r) => [r.external_ref, r]),
  );
  const seen = new Map<string, number>();
  return qs.map((q, i) => {
    const dup = byContent.get(q.content_sha256);
    if (dup) return { status: "duplicate", question_id: dup.question_id, version_id: dup.version_id, is_current: !!dup.is_current };
    const prev = seen.get(q.content_sha256);
    if (prev !== undefined) return { status: "duplicate_in_file", same_as: prev };
    seen.set(q.content_sha256, i);
    const ex = byRef.get(q.ref);
    if (ex && !q.as_new) {
      return { status: "new_version", question_id: ex.id, next_version: ex.max_v + 1, current_blob_sha256: ex.blob, current_format: ex.fmt, current_css: ex.css };
    }
    return { status: "new" };
  });
}

export async function importPreview(req: Request, env: Env) {
  const body = await readJson<{ questions: { ref: string; content_sha256: string }[] }>(req);
  if (!Array.isArray(body.questions)) throw new HttpError(400, "questions must be a list.");
  return json({ results: await classify(env.DB, body.questions) });
}

const sameKey = (a: Row, b: CommitKey) =>
  a.answer_type === b.answer_type &&
  (a.mcq_correct ?? null) === (b.mcq_correct ? JSON.stringify(b.mcq_correct) : null) &&
  (a.numeric_value ?? null) === (b.numeric_value ?? null) &&
  (a.numeric_tolerance ?? null) === (b.numeric_tolerance ?? null) &&
  (a.text_value ?? null) === (b.text_value ?? null);

function coerceField(type: string, v: unknown): Row | null {
  switch (type) {
    case "number": {
      const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
      return Number.isFinite(n) ? { value_number: n } : null;
    }
    case "boolean": {
      if (typeof v === "boolean") return { value_bool: v ? 1 : 0 };
      const s = String(v).trim().toLowerCase();
      if (["yes", "true", "y", "1"].includes(s)) return { value_bool: 1 };
      if (["no", "false", "n", "0"].includes(s)) return { value_bool: 0 };
      return null;
    }
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? { value_date: String(v) } : null;
    default:
      return { value_text: String(v) };
  }
}

export async function importCommit(req: Request, env: Env) {
  const db = env.DB;
  const body = await readJson<CommitBody>(req);
  const t = Date.now();
  need(body.source?.sha256, "source.sha256 is required");
  if (!SHA_RE.test(body.source.sha256)) throw new HttpError(400, "Bad source fingerprint.");
  if (!Array.isArray(body.questions) || !body.questions.length) throw new HttpError(400, "No questions to import.");
  const qs = body.questions;
  const accepted = qs.filter((q) => q.decision !== "reject");

  // 1. Every referenced file must already be stored.
  const needed = new Set<string>([body.source.sha256]);
  for (const q of accepted) {
    needed.add(q.blob_sha256);
    for (const a of q.assets ?? []) if (a.blob_sha256) needed.add(a.blob_sha256);
  }
  const have = new Set((await all<{ sha256: string }>(db, `SELECT sha256 FROM blob WHERE sha256 IN (SELECT value FROM json_each(?))`, JSON.stringify([...needed]))).map((r) => r.sha256));
  const missing = [...needed].filter((h) => !have.has(h));
  if (missing.length) throw new HttpError(409, `${missing.length} file(s) were not uploaded yet; please retry the import.`);

  // 2. Classify.
  const status = await classify(db, accepted.map((q) => ({ ref: q.ref, content_sha256: q.content_sha256, as_new: q.decision === "as_new" })));
  const stmts: D1PreparedStatement[] = [];
  const log: Row[] = [];
  const logChange = (table: string, rowKey: string, column: string, op: string, oldV: unknown, newV: unknown) => {
    const s = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));
    log.push({ table_name: table, row_key: rowKey, column_name: column, op, old_value: s(oldV), new_value: s(newV), changed_at: t });
  };

  const newQs = accepted.filter((_, i) => status[i].status === "new");

  // 3. Subjects (by id, or by name — created when missing).
  const subjectIds = new Map<string, string>(); // lower(name) → id
  const wantNames = new Set<string>();
  const wantIds = new Set<string>();
  for (const q of newQs) {
    if (q.subject?.id) wantIds.add(q.subject.id);
    else if (q.subject?.name?.trim()) wantNames.add(q.subject.name.trim());
  }
  const okIds = new Set((await all<{ id: string }>(db, `SELECT id FROM subject WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify([...wantIds]))).map((r) => r.id));
  for (const r of await all<{ id: string; name: string }>(db, `SELECT id, name FROM subject WHERE archived_at IS NULL`)) subjectIds.set(r.name.toLowerCase(), r.id);
  const subjRows: Row[] = [];
  for (const name of wantNames) {
    if (!subjectIds.has(name.toLowerCase())) {
      const id = ulid(t);
      subjectIds.set(name.toLowerCase(), id);
      subjRows.push({ id, name, created_at: t });
    }
  }
  const subjectOf = (q: CommitQuestion): string | null =>
    q.subject?.id && okIds.has(q.subject.id) ? q.subject.id : q.subject?.name?.trim() ? subjectIds.get(q.subject.name.trim().toLowerCase()) ?? null : null;

  // 4. Topic paths → concept tree under the subject (created when missing, parents first).
  const conceptKey = (subject: string, parent: string | null, name: string) => `${subject}|${parent ?? ""}|${name.toLowerCase()}`;
  const concepts = new Map<string, string>();
  for (const c of await all<{ id: string; subject_id: string; parent_id: string | null; name: string }>(db, `SELECT id, subject_id, parent_id, name FROM concept WHERE archived_at IS NULL`)) {
    concepts.set(conceptKey(c.subject_id, c.parent_id, c.name), c.id);
  }
  const conceptRows: Row[] = [];
  const ensurePath = (subject: string, path: string[]): string | null => {
    let parent: string | null = null;
    for (const raw of path) {
      const name = raw.trim().slice(0, 120);
      if (!name) continue;
      const k = conceptKey(subject, parent, name);
      let id = concepts.get(k);
      if (!id) {
        id = ulid(t);
        concepts.set(k, id);
        conceptRows.push({ id, subject_id: subject, parent_id: parent, name, created_at: t });
      }
      parent = id;
    }
    return parent;
  };

  // 5. Difficulty labels.
  const diffs = await all<{ code: string; sort_rank: number }>(db, `SELECT code, sort_rank FROM difficulty`);
  const diffCodes = new Set(diffs.map((d) => d.code));
  let rank = diffs.reduce((m, d) => Math.max(m, d.sort_rank), 0);
  const diffRows: Row[] = [];
  for (const d of body.new_difficulties ?? []) {
    const code = String(d.code ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (!code || diffCodes.has(code)) continue;
    diffCodes.add(code);
    diffRows.push({ code, label: String(d.label ?? code).trim() || code, sort_rank: ++rank });
  }

  // 6. Custom fields (created when missing; imported fields are filterable).
  const fields = new Map<string, { id: string; data_type: string }>();
  for (const f of await all<{ id: string; name: string; data_type: string }>(db, `SELECT id, name, data_type FROM custom_field WHERE archived_at IS NULL`)) {
    fields.set(f.name.toLowerCase(), { id: f.id, data_type: f.data_type });
  }
  const fieldRows: Row[] = [];
  const fieldOf = (name: string, type: string) => {
    const k = name.trim().toLowerCase();
    let f = fields.get(k);
    if (!f) {
      f = { id: ulid(t), data_type: ["text", "number", "date", "boolean"].includes(type) ? type : "text" };
      fields.set(k, f);
      fieldRows.push({ id: f.id, name: name.trim().slice(0, 80), data_type: f.data_type, is_filterable: 1, created_at: t });
    }
    return f;
  };

  // 7. Rows.
  const sf = await db.prepare(`SELECT id FROM source_file WHERE blob_sha256 = ?`).bind(body.source.sha256).first<{ id: string }>();
  const sourceFileId = sf?.id ?? ulid(t);
  const batchId = ulid(t);
  const qRows: Row[] = [], qUpdates: Row[] = [], vRows: Row[] = [], aRows: Row[] = [], solRows: Row[] = [], keyRows: Row[] = [];
  const tagRows: Row[] = [], fvRows: Row[] = [];
  const retireSol: string[] = [], retireKey: string[] = [];
  const outcome: { position: number; status: string; question_id: string | null }[] = [];
  let nNew = 0, nVer = 0, nDup = 0, nRej = qs.length - accepted.length, nSolUpd = 0, nKeyUpd = 0;
  const usedRefs = new Set<string>();

  // existing metadata for new versions and duplicates
  const touchIds = accepted.flatMap((_, i) => {
    const s = status[i];
    return s.status === "new_version" || s.status === "duplicate" ? [s.question_id] : [];
  });
  const existingQ = new Map((await all(db, `SELECT id, answer_format, option_labels, marks FROM question WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(touchIds))).map((r) => [r.id as string, r]));
  const dupVersionIds = accepted.flatMap((_, i) => {
    const s = status[i];
    return s.status === "duplicate" && s.is_current ? [s.version_id] : [];
  });
  const activeSol = new Map<string, Row>();
  const activeKey = new Map<string, Row>();
  const maxSol = new Map<string, number>();
  const maxKey = new Map<string, number>();
  if (body.update_existing && dupVersionIds.length) {
    const ids = JSON.stringify(dupVersionIds);
    const [s1, s2, s3, s4] = await db.batch([
      db.prepare(`SELECT * FROM solution WHERE retired_at IS NULL AND question_version_id IN (SELECT value FROM json_each(?))`).bind(ids),
      db.prepare(`SELECT * FROM answer_key WHERE retired_at IS NULL AND question_version_id IN (SELECT value FROM json_each(?))`).bind(ids),
      db.prepare(`SELECT question_version_id AS v, max(solution_no) AS m FROM solution WHERE question_version_id IN (SELECT value FROM json_each(?)) GROUP BY 1`).bind(ids),
      db.prepare(`SELECT question_version_id AS v, max(key_no) AS m FROM answer_key WHERE question_version_id IN (SELECT value FROM json_each(?)) GROUP BY 1`).bind(ids),
    ]);
    for (const r of s1.results as Row[]) activeSol.set(r.question_version_id as string, r);
    for (const r of s2.results as Row[]) activeKey.set(r.question_version_id as string, r);
    for (const r of s3.results as Row[]) maxSol.set(r.v as string, r.m as number);
    for (const r of s4.results as Row[]) maxKey.set(r.v as string, r.m as number);
  }

  const addSolutionAndKey = (versionId: string, q: CommitQuestion, solutionNo: number, keyNo: number) => {
    if (q.solution?.body?.trim()) {
      solRows.push({
        id: ulid(t), question_version_id: versionId, solution_no: solutionNo, body_text: q.solution.body,
        body_format: q.solution.format === "html" ? "html" : "markdown", origin: q.solution.origin === "suggestion" ? "suggestion" : "import", created_at: t,
      });
    }
    if (q.key) {
      keyRows.push({
        id: ulid(t), question_version_id: versionId, key_no: keyNo, answer_type: q.key.answer_type,
        mcq_correct: q.key.mcq_correct ? JSON.stringify(q.key.mcq_correct) : null,
        numeric_value: q.key.answer_type === "numeric" ? q.key.numeric_value ?? null : null,
        numeric_tolerance: q.key.answer_type === "numeric" ? q.key.numeric_tolerance ?? 0 : null,
        text_value: q.key.answer_type === "text" ? q.key.text_value ?? "" : null,
        origin: q.key.origin === "suggestion" ? "suggestion" : "import", created_at: t,
      });
    }
  };

  const addVersion = (q: CommitQuestion, questionId: string, versionNo: number) => {
    const versionId = ulid(t);
    vRows.push({
      id: versionId, question_id: questionId, version_no: versionNo, content_sha256: q.content_sha256, html_blob_sha256: q.blob_sha256,
      plain_text: String(q.plain_text ?? "").slice(0, 4000), import_batch_id: batchId, source_position: q.position,
      source_question_number: String(q.number || q.position), created_at: t, content_format: "qpack_v1",
    });
    const seenRef = new Set<string>();
    for (const a of q.assets ?? []) {
      if (seenRef.has(a.ref)) continue;
      seenRef.add(a.ref);
      aRows.push({ question_version_id: versionId, original_ref: a.ref.slice(0, 300), role: a.role ?? "image", blob_sha256: a.blob_sha256 });
    }
    addSolutionAndKey(versionId, q, 1, 1);
    return versionId;
  };

  accepted.forEach((q, i) => {
    const s = status[i];
    if (s.status === "duplicate" || s.status === "duplicate_in_file") {
      nDup++;
      outcome.push({ position: q.position, status: s.status, question_id: s.status === "duplicate" ? s.question_id : null });
      if (s.status === "duplicate" && s.is_current && body.update_existing) {
        // Refresh solution / answer that came from an earlier import; never overwrite your own edits.
        const curSol = activeSol.get(s.version_id);
        if (q.solution?.body?.trim() && (!curSol || (curSol.origin !== "manual" && (curSol.body_text !== q.solution.body || curSol.body_format !== (q.solution.format === "html" ? "html" : "markdown"))))) {
          if (curSol) retireSol.push(curSol.id as string);
          const no = (maxSol.get(s.version_id) ?? 0) + 1;
          const id = ulid(t);
          solRows.push({ id, question_version_id: s.version_id, solution_no: no, body_text: q.solution.body, body_format: q.solution.format === "html" ? "html" : "markdown", origin: q.solution.origin === "suggestion" ? "suggestion" : "import", created_at: t });
          logChange("solution", id, "body_text", curSol ? "update" : "insert", curSol?.body_text ?? null, q.solution.body);
          nSolUpd++;
        }
        const curKey = activeKey.get(s.version_id);
        if (q.key && (!curKey || (curKey.origin !== "manual" && !sameKey(curKey, q.key)))) {
          if (curKey) retireKey.push(curKey.id as string);
          const id = ulid(t);
          keyRows.push({
            id, question_version_id: s.version_id, key_no: (maxKey.get(s.version_id) ?? 0) + 1, answer_type: q.key.answer_type,
            mcq_correct: q.key.mcq_correct ? JSON.stringify(q.key.mcq_correct) : null,
            numeric_value: q.key.answer_type === "numeric" ? q.key.numeric_value ?? null : null,
            numeric_tolerance: q.key.answer_type === "numeric" ? q.key.numeric_tolerance ?? 0 : null,
            text_value: q.key.answer_type === "text" ? q.key.text_value ?? "" : null,
            origin: q.key.origin === "suggestion" ? "suggestion" : "import", created_at: t,
          });
          logChange("answer_key", id, "*", curKey ? "update" : "insert", curKey ? { type: curKey.answer_type, mcq: curKey.mcq_correct, n: curKey.numeric_value, text: curKey.text_value } : null, q.key);
          nKeyUpd++;
        }
      }
      return;
    }
    if (s.status === "new_version") {
      nVer++;
      addVersion(q, s.question_id, s.next_version);
      const cur = existingQ.get(s.question_id) ?? {};
      const upd: Row = { id: s.question_id };
      const nextLabels = q.option_labels?.length ? JSON.stringify(q.option_labels) : null;
      if (cur.answer_format !== q.answer_format) { upd.answer_format = q.answer_format; logChange("question", s.question_id, "answer_format", "update", cur.answer_format, q.answer_format); }
      if ((cur.option_labels ?? null) !== nextLabels) { upd.option_labels = nextLabels; logChange("question", s.question_id, "option_labels", "update", cur.option_labels, nextLabels); }
      if (q.marks !== null && q.marks !== undefined && cur.marks !== q.marks) { upd.marks = q.marks; logChange("question", s.question_id, "marks", "update", cur.marks, q.marks); }
      if (Object.keys(upd).length > 1) qUpdates.push({ answer_format: cur.answer_format, option_labels: cur.option_labels ?? null, marks: cur.marks ?? null, ...upd });
      outcome.push({ position: q.position, status: "new_version", question_id: s.question_id });
      return;
    }
    // new question
    nNew++;
    const id = ulid(t);
    const subject = subjectOf(q);
    let ref: string | null = q.ref?.trim() ? q.ref.trim().slice(0, 300) : null;
    if (ref && (usedRefs.has(ref) || q.decision === "as_new")) ref = q.decision === "as_new" ? null : `${ref}~${q.position}`;
    if (ref) usedRefs.add(ref);
    qRows.push({
      id, subject_id: subject, difficulty_code: q.difficulty_code && diffCodes.has(q.difficulty_code) ? q.difficulty_code : null,
      answer_format: q.answer_format ?? "none", option_labels: q.option_labels?.length ? JSON.stringify(q.option_labels) : null,
      notes: q.notes?.trim() || null, marks: typeof q.marks === "number" && q.marks >= 0 ? q.marks : null, external_ref: ref, created_at: t,
    });
    addVersion(q, id, 1);
    if (subject) {
      const tags = new Map<string, number>();
      for (const tp of q.topics ?? []) {
        const leaf = ensurePath(subject, tp.path ?? []);
        const w = Math.min(1, Math.max(0.001, Number(tp.weight) || 1));
        if (leaf) tags.set(leaf, Math.max(tags.get(leaf) ?? 0, w));
      }
      for (const [concept_id, weight] of tags) tagRows.push({ question_id: id, concept_id, weight, created_at: t });
    }
    const seenField = new Set<string>();
    for (const f of q.fields ?? []) {
      if (!f.name?.trim() || f.value === null || f.value === undefined || f.value === "") continue;
      const def = fieldOf(f.name, f.type);
      if (seenField.has(def.id)) continue;
      const v = coerceField(def.data_type, f.value);
      if (!v) continue;
      seenField.add(def.id);
      fvRows.push({ question_id: id, field_id: def.id, value_text: null, value_number: null, value_date: null, value_bool: null, ...v, updated_at: t });
    }
    outcome.push({ position: q.position, status: "new", question_id: id });
  });

  // 8. One batch.
  const bulk = (table: string, cols: string[], rows: Row[]) => {
    if (rows.length) stmts.push(db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) SELECT ${jx(cols)} FROM json_each(?)`).bind(JSON.stringify(rows)));
  };
  bulk("subject", ["id", "name", "created_at"], subjRows);
  bulk("concept", ["id", "subject_id", "parent_id", "name", "created_at"], conceptRows);
  bulk("difficulty", ["code", "label", "sort_rank"], diffRows);
  bulk("custom_field", ["id", "name", "data_type", "is_filterable", "created_at"], fieldRows);
  if (!sf) stmts.push(db.prepare(`INSERT INTO source_file (id, blob_sha256, file_name, created_at) VALUES (?,?,?,?)`).bind(sourceFileId, body.source.sha256, String(body.source.name || "pack.json").slice(0, 200), t));
  stmts.push(
    db.prepare(
      `INSERT INTO import_batch (id, source_file_id, parser_version, found_count, new_count, new_version_count, duplicate_count, rejected_count, committed_at, label)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(batchId, sourceFileId, String(body.parser_version || "qpack@1").slice(0, 40), qs.length, nNew, nVer, nDup, nRej, t, body.label?.trim() ? body.label.trim().slice(0, 120) : null),
  );
  bulk("question", ["id", "subject_id", "difficulty_code", "answer_format", "option_labels", "notes", "marks", "external_ref", "created_at"], qRows);
  if (qUpdates.length) {
    stmts.push(
      db.prepare(
        `UPDATE question SET
           answer_format = (SELECT json_extract(value,'$.answer_format') FROM json_each(?1) WHERE json_extract(value,'$.id') = question.id),
           option_labels = (SELECT json_extract(value,'$.option_labels') FROM json_each(?1) WHERE json_extract(value,'$.id') = question.id),
           marks = (SELECT json_extract(value,'$.marks') FROM json_each(?1) WHERE json_extract(value,'$.id') = question.id)
         WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?1))`,
      ).bind(JSON.stringify(qUpdates)),
    );
  }
  bulk("question_version", ["id", "question_id", "version_no", "content_sha256", "html_blob_sha256", "plain_text", "import_batch_id", "source_position", "source_question_number", "created_at", "content_format"], vRows);
  bulk("question_version_asset", ["question_version_id", "original_ref", "role", "blob_sha256"], aRows);
  if (retireSol.length) stmts.push(db.prepare(`UPDATE solution SET retired_at = ? WHERE id IN (SELECT value FROM json_each(?))`).bind(t, JSON.stringify(retireSol)));
  bulk("solution", ["id", "question_version_id", "solution_no", "body_text", "body_format", "origin", "created_at"], solRows);
  if (retireKey.length) stmts.push(db.prepare(`UPDATE answer_key SET retired_at = ? WHERE id IN (SELECT value FROM json_each(?))`).bind(t, JSON.stringify(retireKey)));
  bulk("answer_key", ["id", "question_version_id", "key_no", "answer_type", "mcq_correct", "numeric_value", "numeric_tolerance", "text_value", "origin", "created_at"], keyRows);
  bulk("question_concept", ["question_id", "concept_id", "weight", "created_at"], tagRows);
  bulk("question_field_value", ["question_id", "field_id", "value_text", "value_number", "value_date", "value_bool", "updated_at"], fvRows);
  bulk("change_log", ["table_name", "row_key", "column_name", "op", "old_value", "new_value", "changed_at"], log);

  await db.batch(stmts);
  return json({
    import_batch_id: batchId,
    found: qs.length,
    new: nNew,
    new_versions: nVer,
    duplicates: nDup,
    rejected: nRej,
    updated_solutions: nSolUpd,
    updated_keys: nKeyUpd,
    created: { subjects: subjRows.length, topics: conceptRows.length, difficulties: diffRows.length, fields: fieldRows.length },
    outcome,
  });
}

// ---------------------------------------------------------------- import history (undo a bad import)

export async function importList(env: Env) {
  const rows = await all(
    env.DB,
    `SELECT b.id, sf.file_name, b.label, b.note, b.parser_version, b.committed_at, b.found_count, b.new_count, b.new_version_count,
            b.duplicate_count, b.rejected_count,
            (SELECT count(DISTINCT v.question_id) FROM question_version v WHERE v.import_batch_id = b.id) AS question_count,
            (SELECT count(*) FROM question_version v JOIN question q ON q.id = v.question_id
              WHERE v.import_batch_id = b.id AND v.version_no = 1 AND q.archived_at IS NULL) AS active_count,
            (SELECT count(*) FROM question_version v JOIN question q ON q.id = v.question_id
              WHERE v.import_batch_id = b.id AND v.version_no = 1 AND q.archived_at IS NOT NULL) AS archived_count
       FROM import_batch b JOIN source_file sf ON sf.id = b.source_file_id
      ORDER BY b.committed_at DESC`,
  );
  return json({ imports: rows });
}

/** R1: give an import a name and a note. */
export async function importPatch(req: Request, env: Env, batchId: string) {
  const body = await readJson<{ label?: string | null; note?: string | null }>(req);
  const cur = await env.DB.prepare(`SELECT label, note FROM import_batch WHERE id = ?`).bind(batchId).first<{ label: string | null; note: string | null }>();
  if (!cur) throw new HttpError(404, "Import not found.");
  const t = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const col of ["label", "note"] as const) {
    if (!(col in body)) continue;
    const v = body[col]?.trim() ? body[col]!.trim().slice(0, col === "label" ? 120 : 2000) : null;
    if (v === cur[col]) continue;
    stmts.push(
      env.DB.prepare(`UPDATE import_batch SET ${col} = ? WHERE id = ?`).bind(v, batchId),
      env.DB.prepare(`INSERT INTO change_log (table_name, row_key, column_name, op, old_value, new_value, changed_at) VALUES ('import_batch', ?, ?, 'update', ?, ?, ?)`)
        .bind(batchId, col, cur[col], v, t),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true });
}

/** Archive (or bring back) every question that this import first added. Nothing is deleted (DR-7). */
export async function importArchive(req: Request, env: Env, batchId: string) {
  const { archived } = await readJson<{ archived: boolean }>(req);
  const db = env.DB;
  const t = Date.now();
  const target = archived ? t : null;
  const sel = `SELECT question_id FROM question_version WHERE import_batch_id = ?1 AND version_no = 1`;
  const cond = archived ? "archived_at IS NULL" : "archived_at IS NOT NULL";
  const r = await db.batch([
    db.prepare(
      `INSERT INTO change_log (table_name, row_key, column_name, op, old_value, new_value, changed_at)
       SELECT 'question', id, 'archived_at', 'update', CAST(archived_at AS TEXT), CAST(?2 AS TEXT), ?3
         FROM question WHERE id IN (${sel}) AND ${cond}`,
    ).bind(batchId, target, t),
    db.prepare(`UPDATE question SET archived_at = ?2 WHERE id IN (${sel}) AND ${cond}`).bind(batchId, target),
  ]);
  return json({ changed: r[1].meta.changes });
}
