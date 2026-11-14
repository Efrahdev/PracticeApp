import { ulid } from "../shared/ulid";
import { HttpError, json, readJson, need, SHA_RE, DATE_RE, sha256Bytes } from "./http";
import {
  liveUpdateStatements,
  questionStatStatement,
  rebuildDailyStatements,
} from "./metrics";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  DEV_ALLOW_NO_AUTH?: string;
}

type Row = Record<string, unknown>;
const now = () => Date.now();
const blobKey = (sha: string) => `blob/${sha}`;

async function all<T = Row>(db: D1Database, sql: string, ...args: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...args).all<T>()).results;
}
async function first<T = Row>(db: D1Database, sql: string, ...args: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...args).first<T>();
}

function logChange(
  db: D1Database,
  table: string,
  rowKey: string,
  column: string,
  op: "insert" | "update" | "delete",
  oldV: unknown,
  newV: unknown,
  at: number,
): D1PreparedStatement {
  const s = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));
  return db
    .prepare(
      `INSERT INTO change_log (table_name, row_key, column_name, op, old_value, new_value, changed_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .bind(table, rowKey, column, op, s(oldV), s(newV), at);
}

// ------------------------------------------------------------------ blobs (R2)

export async function blobsCheck(req: Request, env: Env) {
  const { hashes } = await readJson<{ hashes: string[] }>(req);
  const list = (hashes ?? []).filter((h) => SHA_RE.test(h));
  const have = new Set(
    (await all<{ sha256: string }>(env.DB, `SELECT sha256 FROM blob WHERE sha256 IN (SELECT value FROM json_each(?))`, JSON.stringify(list)))
      .map((r) => r.sha256),
  );
  return json({ missing: list.filter((h) => !have.has(h)) });
}

/** Several small text blobs in one request: [{sha256, mime, text}]. */
export async function blobsUploadText(req: Request, env: Env) {
  const { items } = await readJson<{ items: { sha256: string; mime: string; text: string }[] }>(req);
  if (!Array.isArray(items) || items.length === 0 || items.length > 40) throw new HttpError(400, "Send 1–40 items.");
  const enc = new TextEncoder();
  const rows: { sha256: string; byte_size: number; mime_type: string; created_at: number }[] = [];
  for (const it of items) {
    const bytes = enc.encode(it.text);
    const sha = await sha256Bytes(bytes);
    if (sha !== it.sha256) throw new HttpError(400, `Fingerprint mismatch for ${it.sha256.slice(0, 12)}…`);
    rows.push({ sha256: sha, byte_size: bytes.byteLength, mime_type: it.mime || "application/octet-stream", created_at: now() });
  }
  await Promise.all(
    items.map((it, i) =>
      env.FILES.put(blobKey(rows[i].sha256), it.text, { httpMetadata: { contentType: rows[i].mime_type } }),
    ),
  );
  await env.DB.prepare(
    `INSERT OR IGNORE INTO blob (sha256, byte_size, mime_type, created_at)
     SELECT json_extract(value,'$.sha256'), json_extract(value,'$.byte_size'),
            json_extract(value,'$.mime_type'), json_extract(value,'$.created_at') FROM json_each(?)`,
  ).bind(JSON.stringify(rows)).run();
  return json({ stored: rows.length });
}

/** One raw blob (original uploads, binary assets, restores). */
export async function blobPut(req: Request, env: Env, sha: string) {
  if (!SHA_RE.test(sha)) throw new HttpError(400, "Bad fingerprint.");
  const mime = new URL(req.url).searchParams.get("mime") || req.headers.get("content-type") || "application/octet-stream";
  const bytes = await req.arrayBuffer();
  const actual = await sha256Bytes(bytes);
  if (actual !== sha) throw new HttpError(400, "Fingerprint does not match the bytes sent.");
  await env.FILES.put(blobKey(sha), bytes, { httpMetadata: { contentType: mime } });
  await env.DB.prepare(`INSERT OR IGNORE INTO blob (sha256, byte_size, mime_type, created_at) VALUES (?,?,?,?)`)
    .bind(sha, bytes.byteLength, mime, now()).run();
  return json({ stored: sha });
}

export async function blobGet(env: Env, sha: string) {
  if (!SHA_RE.test(sha)) throw new HttpError(400, "Bad fingerprint.");
  const obj = await env.FILES.get(blobKey(sha));
  if (!obj) throw new HttpError(404, "File not found in storage.");
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "private, max-age=31536000, immutable",
      // If ever opened directly, the file cannot run scripts or call out.
      "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
      "x-content-type-options": "nosniff",
    },
  });
}

// ------------------------------------------------------------------ bootstrap & library

export async function bootstrap(env: Env) {
  const [subjects, concepts, difficulties, errorTypes, filters, version] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM subject ORDER BY name COLLATE NOCASE`),
    env.DB.prepare(`SELECT * FROM concept ORDER BY name COLLATE NOCASE`),
    env.DB.prepare(`SELECT * FROM difficulty ORDER BY sort_rank`),
    env.DB.prepare(`SELECT * FROM error_type WHERE archived_at IS NULL ORDER BY label`),
    env.DB.prepare(`SELECT * FROM saved_filter WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE`),
    env.DB.prepare(`SELECT max(version) AS v FROM schema_migration`),
  ]);
  return json({
    subjects: subjects.results,
    concepts: concepts.results,
    difficulties: difficulties.results,
    errorTypes: errorTypes.results,
    filters: filters.results,
    schemaVersion: (version.results[0] as Row)?.v ?? null,
  });
}

/** All question metadata in one go; filtering runs on the device. */
export async function library(env: Env) {
  const rows = await all(
    env.DB,
    `SELECT v.id, v.subject_id, v.difficulty_code, v.answer_format, v.created_at, v.archived_at,
            v.version_id, v.version_no, v.source_question_number AS qno, v.plain_text,
            sf.file_name,
            (SELECT json_group_array(json_array(concept_id, weight)) FROM question_concept WHERE question_id = v.id) AS concepts,
            EXISTS (SELECT 1 FROM answer_key k WHERE k.question_version_id = v.version_id AND k.retired_at IS NULL) AS has_key,
            s.attempt_count, s.graded_count, s.correct_count, s.score_permille_sum, s.total_time_seconds,
            s.last_attempted_at, s.last_time_seconds, s.last_result,
            s.personal_difficulty_permille, s.familiarity_permille
       FROM v_question_current v
       JOIN import_batch b ON b.id = v.import_batch_id
       JOIN source_file sf ON sf.id = b.source_file_id
       LEFT JOIN question_stat s ON s.question_id = v.id
      ORDER BY v.id`,
  );
  return json({ questions: rows });
}

export async function questionDetail(env: Env, id: string) {
  const q = await first(env.DB, `SELECT * FROM v_question_current WHERE id = ?`, id);
  if (!q) throw new HttpError(404, "Question not found.");
  const vid = q.version_id as string;
  const [versions, concepts, key, solution, css, attempts, grades, source] = await env.DB.batch([
    env.DB.prepare(`SELECT id, version_no, content_sha256, html_blob_sha256, import_batch_id, source_position, source_question_number, created_at
                    FROM question_version WHERE question_id = ? ORDER BY version_no`).bind(id),
    env.DB.prepare(`SELECT concept_id, weight FROM question_concept WHERE question_id = ?`).bind(id),
    env.DB.prepare(`SELECT * FROM answer_key WHERE question_version_id = ? AND retired_at IS NULL`).bind(vid),
    env.DB.prepare(`SELECT * FROM solution WHERE question_version_id = ? AND retired_at IS NULL`).bind(vid),
    env.DB.prepare(`SELECT question_version_id, blob_sha256 FROM question_version_asset
                    WHERE question_version_id IN (SELECT id FROM question_version WHERE question_id = ?) AND role = 'stylesheet'`).bind(id),
    env.DB.prepare(`SELECT * FROM attempt WHERE question_id = ? ORDER BY attempted_at DESC`).bind(id),
    env.DB.prepare(`SELECT g.* FROM grade g JOIN attempt a ON a.id = g.attempt_id WHERE a.question_id = ? ORDER BY g.grade_no`).bind(id),
    env.DB.prepare(`SELECT sf.file_name, b.committed_at FROM import_batch b JOIN source_file sf ON sf.id = b.source_file_id WHERE b.id = ?`).bind(q.import_batch_id),
  ]);
  const stat = await first(env.DB, `SELECT * FROM question_stat WHERE question_id = ?`, id);
  return json({
    question: q,
    versions: versions.results,
    concepts: concepts.results,
    answerKey: key.results[0] ?? null,
    solution: solution.results[0] ?? null,
    stylesheets: css.results,
    attempts: attempts.results,
    grades: grades.results,
    source: source.results[0] ?? null,
    stat,
  });
}

// ------------------------------------------------------------------ import (FR-1.1–1.4, DR-1/2/4)

interface ImportQuestionIn {
  position: number;
  number: string;
  category_key: string | null;
  band: string | null;
  html_sha256: string;
  content_sha256: string;
  plain_text: string;
  solution_sha256: string | null;
  accept: boolean;
}

async function classify(env: Env, fileName: string, qs: { number: string; content_sha256: string }[]) {
  const byContent = new Map(
    (await all<{ content_sha256: string; question_id: string }>(
      env.DB,
      `SELECT content_sha256, question_id FROM question_version WHERE content_sha256 IN (SELECT value FROM json_each(?))`,
      JSON.stringify(qs.map((q) => q.content_sha256)),
    )).map((r) => [r.content_sha256, r.question_id]),
  );
  // Same file name + same printed question number = the same question (a changed one becomes a new version).
  const bySource = new Map<string, { question_id: string; version_no: number }>();
  for (const r of await all<{ question_id: string; qno: string; version_no: number }>(
    env.DB,
    `SELECT v.id AS question_id, v.source_question_number AS qno, v.version_no
       FROM v_question_current v
       JOIN import_batch b ON b.id = v.import_batch_id
       JOIN source_file sf ON sf.id = b.source_file_id
      WHERE sf.file_name = ? AND v.archived_at IS NULL
      ORDER BY v.created_at`,
    fileName,
  )) bySource.set(r.qno, { question_id: r.question_id, version_no: r.version_no });

  const seen = new Map<string, number>();
  return qs.map((q, i) => {
    const dupOf = byContent.get(q.content_sha256);
    if (dupOf) return { status: "duplicate" as const, question_id: dupOf };
    if (seen.has(q.content_sha256)) return { status: "duplicate_in_file" as const, question_id: null, same_as: seen.get(q.content_sha256) };
    seen.set(q.content_sha256, i);
    const src = bySource.get(q.number);
    if (src) return { status: "new_version" as const, question_id: src.question_id, next_version: src.version_no + 1 };
    return { status: "new" as const, question_id: null };
  });
}

export async function importPreview(req: Request, env: Env) {
  const body = await readJson<{ file_name: string; questions: { number: string; content_sha256: string }[] }>(req);
  need(body.file_name, "file_name is required");
  return json({ results: await classify(env, body.file_name, body.questions ?? []) });
}

export async function importCommit(req: Request, env: Env) {
  const body = await readJson<{
    file: { sha256: string; name: string };
    css_sha256: string;
    parser_version: string;
    subject: { id?: string; name?: string } | null;
    categories: { key: string; name: string }[];
    questions: ImportQuestionIn[];
  }>(req);
  const db = env.DB;
  const t = now();
  need(body.file?.sha256, "file.sha256 is required");
  need(body.file?.name, "file.name is required");
  if (!Array.isArray(body.questions) || body.questions.length === 0) throw new HttpError(400, "No questions to import.");

  // Every referenced file must already be in storage.
  const needed = new Set<string>([body.file.sha256, body.css_sha256]);
  for (const q of body.questions) {
    if (!q.accept) continue;
    needed.add(q.html_sha256);
    if (q.solution_sha256) needed.add(q.solution_sha256);
  }
  const have = new Set(
    (await all<{ sha256: string }>(db, `SELECT sha256 FROM blob WHERE sha256 IN (SELECT value FROM json_each(?))`, JSON.stringify([...needed])))
      .map((r) => r.sha256),
  );
  const missing = [...needed].filter((h) => !have.has(h));
  if (missing.length) throw new HttpError(409, `${missing.length} file(s) were not uploaded yet; retry the import.`);

  const status = await classify(env, body.file.name, body.questions);
  const stmts: D1PreparedStatement[] = [];

  // Subject: existing id, existing name, or new.
  let subjectId: string | null = null;
  if (body.subject?.id) {
    const s = await first(db, `SELECT id FROM subject WHERE id = ?`, body.subject.id);
    if (!s) throw new HttpError(400, "Chosen subject does not exist.");
    subjectId = body.subject.id;
  } else if (body.subject?.name?.trim()) {
    const name = body.subject.name.trim();
    const s = await first<{ id: string }>(db, `SELECT id FROM subject WHERE name = ? COLLATE NOCASE AND archived_at IS NULL`, name);
    if (s) subjectId = s.id;
    else {
      subjectId = ulid(t);
      stmts.push(db.prepare(`INSERT INTO subject (id, name, created_at) VALUES (?,?,?)`).bind(subjectId, name, t));
    }
  }

  // Categories become top-level concepts under the subject (matched by name).
  const conceptByKey = new Map<string, string>();
  if (subjectId) {
    const existing = await all<{ id: string; name: string }>(
      db,
      `SELECT id, name FROM concept WHERE subject_id = ? AND parent_id IS NULL AND archived_at IS NULL`,
      subjectId,
    );
    const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c.id]));
    for (const c of body.categories ?? []) {
      const nm = (c.name ?? "").trim();
      if (!nm) continue;
      let id = byName.get(nm.toLowerCase());
      if (!id) {
        id = ulid(t);
        byName.set(nm.toLowerCase(), id);
        stmts.push(db.prepare(`INSERT INTO concept (id, subject_id, parent_id, name, created_at) VALUES (?,?,NULL,?,?)`).bind(id, subjectId, nm, t));
      }
      conceptByKey.set(c.key, id);
    }
  }

  // Source file (same bytes = same row) and the batch.
  const sf = await first<{ id: string }>(db, `SELECT id FROM source_file WHERE blob_sha256 = ?`, body.file.sha256);
  const sourceFileId = sf?.id ?? ulid(t);
  if (!sf) {
    stmts.push(db.prepare(`INSERT INTO source_file (id, blob_sha256, file_name, created_at) VALUES (?,?,?,?)`)
      .bind(sourceFileId, body.file.sha256, body.file.name, t));
  }
  const batchId = ulid(t);
  const difficulties = new Set((await all<{ code: string }>(db, `SELECT code FROM difficulty WHERE archived_at IS NULL`)).map((r) => r.code));

  const qRows: Row[] = [];
  const vRows: Row[] = [];
  const aRows: Row[] = [];
  const solRows: Row[] = [];
  const tagRows: Row[] = [];
  let newCount = 0, newVersionCount = 0, dupCount = 0, rejected = 0;
  const outcome: { position: number; status: string; question_id: string | null }[] = [];

  body.questions.forEach((q, i) => {
    const st = status[i];
    if (!q.accept) {
      rejected++;
      outcome.push({ position: q.position, status: "rejected", question_id: null });
      return;
    }
    if (st.status === "duplicate" || st.status === "duplicate_in_file") {
      dupCount++;
      outcome.push({ position: q.position, status: "duplicate", question_id: st.question_id });
      return;
    }
    let questionId: string;
    let versionNo = 1;
    if (st.status === "new_version") {
      questionId = st.question_id!;
      versionNo = st.next_version!;
      newVersionCount++;
    } else {
      questionId = ulid(t);
      newCount++;
      qRows.push({
        id: questionId,
        subject_id: subjectId,
        difficulty_code: q.band && difficulties.has(q.band) ? q.band : null,
        created_at: t,
      });
      const cid = q.category_key ? conceptByKey.get(q.category_key) : undefined;
      if (cid) tagRows.push({ question_id: questionId, concept_id: cid, weight: 1.0, created_at: t });
    }
    const versionId = ulid(t);
    vRows.push({
      id: versionId,
      question_id: questionId,
      version_no: versionNo,
      content_sha256: q.content_sha256,
      html_blob_sha256: q.html_sha256,
      plain_text: q.plain_text ?? "",
      import_batch_id: batchId,
      source_position: q.position,
      source_question_number: String(q.number),
      created_at: t,
    });
    aRows.push({ question_version_id: versionId, original_ref: "<style> blocks", role: "stylesheet", blob_sha256: body.css_sha256 });
    if (q.solution_sha256) {
      solRows.push({ id: ulid(t), question_version_id: versionId, solution_no: 1, body_blob_sha256: q.solution_sha256, origin: "import", created_at: t });
    }
    outcome.push({ position: q.position, status: st.status, question_id: questionId });
  });

  stmts.push(
    db.prepare(
      `INSERT INTO import_batch (id, source_file_id, parser_version, found_count, new_count, new_version_count, duplicate_count, rejected_count, committed_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(batchId, sourceFileId, body.parser_version ?? "unknown", body.questions.length, newCount, newVersionCount, dupCount, rejected, t),
  );
  const jx = (cols: string[]) => cols.map((c) => `json_extract(value,'$.${c}')`).join(", ");
  const bulk = (table: string, cols: string[], rows: Row[]) => {
    if (rows.length) {
      stmts.push(db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) SELECT ${jx(cols)} FROM json_each(?)`).bind(JSON.stringify(rows)));
    }
  };
  bulk("question", ["id", "subject_id", "difficulty_code", "created_at"], qRows);
  bulk("question_version", ["id", "question_id", "version_no", "content_sha256", "html_blob_sha256", "plain_text", "import_batch_id", "source_position", "source_question_number", "created_at"], vRows);
  bulk("question_version_asset", ["question_version_id", "original_ref", "role", "blob_sha256"], aRows);
  bulk("solution", ["id", "question_version_id", "solution_no", "body_blob_sha256", "origin", "created_at"], solRows);
  bulk("question_concept", ["question_id", "concept_id", "weight", "created_at"], tagRows);

  await db.batch(stmts); // all-or-nothing (DR-4)
  return json({
    import_batch_id: batchId,
    found: body.questions.length,
    new: newCount,
    new_versions: newVersionCount,
    duplicates: dupCount,
    rejected,
    outcome,
  });
}

// ------------------------------------------------------------------ metadata edits (FR-1.6, DR-3)

export async function questionPatch(req: Request, env: Env, id: string) {
  const db = env.DB;
  const body = await readJson<{
    subject_id?: string | null;
    difficulty_code?: string | null;
    answer_format?: string;
    option_labels?: string[] | null;
    notes?: string | null;
    archived?: boolean;
    concepts?: { concept_id: string; weight: number }[];
  }>(req);
  const cur = await first(db, `SELECT * FROM question WHERE id = ?`, id);
  if (!cur) throw new HttpError(404, "Question not found.");
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  let dailyRebuild = false;
  let statRebuild = false;

  const fields: Record<string, unknown> = {};
  if ("subject_id" in body) fields.subject_id = body.subject_id || null;
  if ("difficulty_code" in body) fields.difficulty_code = body.difficulty_code || null;
  if ("answer_format" in body) fields.answer_format = body.answer_format;
  if ("option_labels" in body) fields.option_labels = body.option_labels && body.option_labels.length ? JSON.stringify(body.option_labels) : null;
  if ("notes" in body) fields.notes = body.notes?.trim() ? body.notes : null;
  if ("archived" in body) fields.archived_at = body.archived ? (cur.archived_at ?? t) : null;

  for (const [col, val] of Object.entries(fields)) {
    if (cur[col] === val) continue;
    stmts.push(db.prepare(`UPDATE question SET ${col} = ? WHERE id = ?`).bind(val, id));
    stmts.push(logChange(db, "question", id, col, "update", cur[col], val, t));
    if (col === "subject_id") dailyRebuild = true;
    if (col === "difficulty_code") statRebuild = true;
  }

  if (body.concepts) {
    const curTags = new Map(
      (await all<{ concept_id: string; weight: number }>(db, `SELECT concept_id, weight FROM question_concept WHERE question_id = ?`, id))
        .map((r) => [r.concept_id, r.weight]),
    );
    const next = new Map<string, number>();
    for (const c of body.concepts) {
      const w = Number(c.weight);
      if (!(w > 0 && w <= 1)) throw new HttpError(400, "Concept weights must be above 0 and at most 1.");
      next.set(c.concept_id, Math.round(w * 1000) / 1000);
    }
    for (const [cid, w] of curTags) {
      if (!next.has(cid)) {
        stmts.push(db.prepare(`DELETE FROM question_concept WHERE question_id = ? AND concept_id = ?`).bind(id, cid));
        stmts.push(logChange(db, "question_concept", `${id}|${cid}`, "weight", "delete", w, null, t));
        dailyRebuild = true;
      }
    }
    for (const [cid, w] of next) {
      const old = curTags.get(cid);
      if (old === undefined) {
        stmts.push(db.prepare(`INSERT INTO question_concept (question_id, concept_id, weight, created_at) VALUES (?,?,?,?)`).bind(id, cid, w, t));
        stmts.push(logChange(db, "question_concept", `${id}|${cid}`, "weight", "insert", null, w, t));
        dailyRebuild = true;
      } else if (old !== w) {
        stmts.push(db.prepare(`UPDATE question_concept SET weight = ? WHERE question_id = ? AND concept_id = ?`).bind(w, id, cid));
        stmts.push(logChange(db, "question_concept", `${id}|${cid}`, "weight", "update", old, w, t));
        dailyRebuild = true;
      }
    }
  }
  if (!stmts.length) return json({ changed: 0 });
  if (statRebuild) stmts.push(questionStatStatement(db, id));
  if (dailyRebuild) stmts.push(...rebuildDailyStatements(db));
  await db.batch(stmts);
  return json({ changed: stmts.length });
}

/** FR-1.7: set subject / difficulty on many questions at once. */
export async function questionsBulk(req: Request, env: Env) {
  const body = await readJson<{ ids: string[]; subject_id?: string | null; difficulty_code?: string | null; add_concept?: { concept_id: string; weight: number } }>(req);
  const db = env.DB;
  if (!Array.isArray(body.ids) || !body.ids.length) throw new HttpError(400, "No questions selected.");
  const t = now();
  const cur = await all(db, `SELECT id, subject_id, difficulty_code FROM question WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(body.ids));
  const stmts: D1PreparedStatement[] = [];
  let daily = false;
  for (const q of cur) {
    for (const col of ["subject_id", "difficulty_code"] as const) {
      if (!(col in body)) continue;
      const val = body[col] || null;
      if (q[col] === val) continue;
      stmts.push(db.prepare(`UPDATE question SET ${col} = ? WHERE id = ?`).bind(val, q.id));
      stmts.push(logChange(db, "question", q.id as string, col, "update", q[col], val, t));
      if (col === "subject_id") daily = true;
      else stmts.push(questionStatStatement(db, q.id as string));
    }
    if (body.add_concept) {
      const w = Number(body.add_concept.weight);
      if (!(w > 0 && w <= 1)) throw new HttpError(400, "Weight must be above 0 and at most 1.");
      stmts.push(db.prepare(`INSERT OR IGNORE INTO question_concept (question_id, concept_id, weight, created_at) VALUES (?,?,?,?)`)
        .bind(q.id, body.add_concept.concept_id, w, t));
      stmts.push(logChange(db, "question_concept", `${q.id}|${body.add_concept.concept_id}`, "weight", "insert", null, w, t));
      daily = true;
    }
  }
  if (!stmts.length) return json({ changed: 0 });
  if (daily) stmts.push(...rebuildDailyStatements(db));
  await db.batch(stmts);
  return json({ changed: cur.length });
}

export async function answerKeySet(req: Request, env: Env, id: string) {
  const db = env.DB;
  const body = await readJson<{
    answer_type?: string;
    mcq_correct?: string[];
    numeric_value?: number;
    numeric_tolerance?: number;
    text_value?: string;
    remove?: boolean;
  }>(req);
  const q = await first<{ version_id: string }>(db, `SELECT version_id FROM v_question_current WHERE id = ?`, id);
  if (!q) throw new HttpError(404, "Question not found.");
  const t = now();
  const active = await first(db, `SELECT * FROM answer_key WHERE question_version_id = ? AND retired_at IS NULL`, q.version_id);
  const stmts: D1PreparedStatement[] = [];
  if (active) {
    stmts.push(db.prepare(`UPDATE answer_key SET retired_at = ? WHERE id = ?`).bind(t, active.id));
    stmts.push(logChange(db, "answer_key", active.id as string, "retired_at", "update", null, t, t));
  }
  if (!body.remove) {
    const type = need(body.answer_type, "answer_type is required");
    if (!["mcq_single", "mcq_multi", "numeric", "text"].includes(type)) throw new HttpError(400, "Unknown answer type.");
    const max = await first<{ m: number | null }>(db, `SELECT max(key_no) AS m FROM answer_key WHERE question_version_id = ?`, q.version_id);
    const keyId = ulid(t);
    const mcq = type.startsWith("mcq") ? JSON.stringify(need(body.mcq_correct, "Choose the correct option(s)")) : null;
    if (type === "mcq_single" && body.mcq_correct!.length !== 1) throw new HttpError(400, "Single-choice keys need exactly one option.");
    stmts.push(
      db.prepare(
        `INSERT INTO answer_key (id, question_version_id, key_no, answer_type, mcq_correct, numeric_value, numeric_tolerance, text_value, origin, created_at)
         VALUES (?,?,?,?,?,?,?,?,'manual',?)`,
      ).bind(
        keyId, q.version_id, (max?.m ?? 0) + 1, type, mcq,
        type === "numeric" ? Number(need(body.numeric_value, "numeric_value is required")) : null,
        type === "numeric" ? Number(body.numeric_tolerance ?? 0) : null,
        type === "text" ? need(body.text_value, "text_value is required") : null,
        t,
      ),
    );
    stmts.push(logChange(db, "answer_key", keyId, "*", "insert", null, { type, mcq, n: body.numeric_value, tol: body.numeric_tolerance, text: body.text_value }, t));
  }
  if (stmts.length) await db.batch(stmts);
  return json({ ok: true });
}

export async function solutionSet(req: Request, env: Env, id: string) {
  const db = env.DB;
  const body = await readJson<{ body_text: string }>(req);
  const text = need(body.body_text, "Write the solution first.");
  const q = await first<{ version_id: string }>(db, `SELECT version_id FROM v_question_current WHERE id = ?`, id);
  if (!q) throw new HttpError(404, "Question not found.");
  const t = now();
  const active = await first(db, `SELECT * FROM solution WHERE question_version_id = ? AND retired_at IS NULL`, q.version_id);
  const max = await first<{ m: number | null }>(db, `SELECT max(solution_no) AS m FROM solution WHERE question_version_id = ?`, q.version_id);
  const sid = ulid(t);
  const stmts: D1PreparedStatement[] = [];
  if (active) stmts.push(db.prepare(`UPDATE solution SET retired_at = ? WHERE id = ?`).bind(t, active.id));
  stmts.push(
    db.prepare(`INSERT INTO solution (id, question_version_id, solution_no, body_text, origin, created_at) VALUES (?,?,?,?,'manual',?)`)
      .bind(sid, q.version_id, (max?.m ?? 0) + 1, text, t),
  );
  stmts.push(logChange(db, "solution", sid, "body_text", active ? "update" : "insert", active?.body_text ?? active?.body_blob_sha256 ?? null, text, t));
  await db.batch(stmts);
  return json({ ok: true });
}

// ------------------------------------------------------------------ taxonomy (subjects, concepts)

export async function subjectCreate(req: Request, env: Env) {
  const { name } = await readJson<{ name: string }>(req);
  const id = ulid();
  try {
    await env.DB.prepare(`INSERT INTO subject (id, name, created_at) VALUES (?,?,?)`).bind(id, need(name, "Name is required").trim(), now()).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new HttpError(409, "A subject with that name already exists.");
    throw e;
  }
  return json({ id });
}

export async function subjectPatch(req: Request, env: Env, id: string) {
  const body = await readJson<{ name?: string; archived?: boolean }>(req);
  const cur = await first(env.DB, `SELECT * FROM subject WHERE id = ?`, id);
  if (!cur) throw new HttpError(404, "Subject not found.");
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  if (body.name !== undefined && body.name.trim() && body.name.trim() !== cur.name) {
    stmts.push(env.DB.prepare(`UPDATE subject SET name = ? WHERE id = ?`).bind(body.name.trim(), id));
    stmts.push(logChange(env.DB, "subject", id, "name", "update", cur.name, body.name.trim(), t));
  }
  if (body.archived !== undefined) {
    const v = body.archived ? (cur.archived_at ?? t) : null;
    stmts.push(env.DB.prepare(`UPDATE subject SET archived_at = ? WHERE id = ?`).bind(v, id));
    stmts.push(logChange(env.DB, "subject", id, "archived_at", "update", cur.archived_at, v, t));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true });
}

export async function conceptCreate(req: Request, env: Env) {
  const body = await readJson<{ subject_id: string; parent_id?: string | null; name: string }>(req);
  const id = ulid();
  try {
    await env.DB.prepare(`INSERT INTO concept (id, subject_id, parent_id, name, created_at) VALUES (?,?,?,?,?)`)
      .bind(id, need(body.subject_id, "Choose a subject"), body.parent_id || null, need(body.name, "Name is required").trim(), now()).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new HttpError(409, "That concept already exists here.");
    throw e;
  }
  return json({ id });
}

export async function conceptPatch(req: Request, env: Env, id: string) {
  const body = await readJson<{ name?: string; parent_id?: string | null; archived?: boolean }>(req);
  const cur = await first(env.DB, `SELECT * FROM concept WHERE id = ?`, id);
  if (!cur) throw new HttpError(404, "Concept not found.");
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  const set = (col: string, val: unknown) => {
    if (cur[col] === val) return;
    stmts.push(env.DB.prepare(`UPDATE concept SET ${col} = ? WHERE id = ?`).bind(val, id));
    stmts.push(logChange(env.DB, "concept", id, col, "update", cur[col], val, t));
  };
  if (body.name !== undefined && body.name.trim()) set("name", body.name.trim());
  if (body.parent_id !== undefined) {
    const p = body.parent_id || null;
    if (p === id) throw new HttpError(400, "A concept cannot be its own parent.");
    if (p) {
      // refuse cycles
      const chain = await all<{ id: string }>(
        env.DB,
        `WITH RECURSIVE up(id, parent_id) AS (SELECT id, parent_id FROM concept WHERE id = ?
           UNION ALL SELECT c.id, c.parent_id FROM concept c JOIN up ON c.id = up.parent_id)
         SELECT id FROM up`,
        p,
      );
      if (chain.some((r) => r.id === id)) throw new HttpError(400, "That would make a loop in the concept tree.");
    }
    set("parent_id", p);
  }
  if (body.archived !== undefined) set("archived_at", body.archived ? (cur.archived_at ?? t) : null);
  if (stmts.length) {
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new HttpError(409, "A concept with that name already exists at this level.");
      throw e;
    }
  }
  return json({ ok: true });
}

// ------------------------------------------------------------------ saved filters (FR-2.6)

export async function filterSave(req: Request, env: Env, id?: string) {
  const body = await readJson<{ name: string; definition: unknown }>(req);
  const name = need(body.name, "Give the filter a name").trim();
  const def = JSON.stringify(need(body.definition, "definition is required"));
  const t = now();
  try {
    if (id) {
      await env.DB.prepare(`UPDATE saved_filter SET name = ?, definition = ?, updated_at = ? WHERE id = ?`).bind(name, def, t, id).run();
      return json({ id });
    }
    const nid = ulid(t);
    await env.DB.prepare(`INSERT INTO saved_filter (id, name, definition, created_at, updated_at) VALUES (?,?,?,?,?)`).bind(nid, name, def, t, t).run();
    return json({ id: nid });
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new HttpError(409, "A saved filter with that name already exists.");
    throw e;
  }
}

export async function filterArchive(env: Env, id: string) {
  await env.DB.prepare(`UPDATE saved_filter SET archived_at = ? WHERE id = ?`).bind(now(), id).run();
  return json({ ok: true });
}

// ------------------------------------------------------------------ papers (FR-3)

export async function paperCreate(req: Request, env: Env) {
  const db = env.DB;
  const body = await readJson<{
    name: string;
    saved_filter_id?: string | null;
    filter_definition: unknown;
    sampling_settings: unknown;
    seed: number;
    generator_version: number;
    requested_count: number;
    items: { question_id: string; question_version_id: string; pick_reason?: unknown }[];
  }>(req);
  const items = body.items ?? [];
  if (!items.length) throw new HttpError(400, "The paper has no questions.");
  if (new Set(items.map((i) => i.question_id)).size !== items.length) throw new HttpError(400, "A question appears twice in the paper.");
  const okVersions = await all<{ id: string; question_id: string }>(
    db,
    `SELECT id, question_id FROM question_version WHERE id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(items.map((i) => i.question_version_id)),
  );
  const vmap = new Map(okVersions.map((v) => [v.id, v.question_id]));
  for (const it of items) if (vmap.get(it.question_version_id) !== it.question_id) throw new HttpError(400, "Paper refers to an unknown question version.");
  const t = now();
  const id = ulid(t);
  const rows = items.map((it, i) => ({
    paper_id: id,
    position: i + 1,
    question_id: it.question_id,
    question_version_id: it.question_version_id,
    pick_reason: it.pick_reason === undefined ? null : JSON.stringify(it.pick_reason),
  }));
  await db.batch([
    db.prepare(
      `INSERT INTO paper (id, name, saved_filter_id, filter_definition, sampling_settings, seed, generator_version, requested_count, created_at, frozen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, need(body.name, "Give the paper a name").trim(), body.saved_filter_id || null, JSON.stringify(body.filter_definition ?? {}),
      JSON.stringify(body.sampling_settings ?? {}), Math.trunc(body.seed), Math.trunc(body.generator_version ?? 1),
      Math.max(1, Math.trunc(body.requested_count || items.length)), t, t),
    db.prepare(
      `INSERT INTO paper_item (paper_id, position, question_id, question_version_id, pick_reason)
       SELECT json_extract(value,'$.paper_id'), json_extract(value,'$.position'), json_extract(value,'$.question_id'),
              json_extract(value,'$.question_version_id'), json_extract(value,'$.pick_reason') FROM json_each(?)`,
    ).bind(JSON.stringify(rows)),
  ]);
  return json({ id });
}

export async function paperList(env: Env) {
  const rows = await all(
    env.DB,
    `SELECT p.id, p.name, p.seed, p.requested_count, p.created_at, p.frozen_at,
            (SELECT count(*) FROM paper_item WHERE paper_id = p.id) AS item_count,
            (SELECT id FROM practice_session WHERE paper_id = p.id AND completed_at IS NULL) AS open_session_id,
            (SELECT current_position FROM practice_session WHERE paper_id = p.id AND completed_at IS NULL) AS open_position,
            (SELECT count(*) FROM practice_session WHERE paper_id = p.id AND completed_at IS NOT NULL) AS completed_sessions
       FROM paper p WHERE p.archived_at IS NULL ORDER BY p.created_at DESC`,
  );
  return json({ papers: rows });
}

export async function paperDetail(env: Env, id: string) {
  const db = env.DB;
  const paper = await first(db, `SELECT * FROM paper WHERE id = ?`, id);
  if (!paper) throw new HttpError(404, "Paper not found.");
  const [items, sessions, attempts] = await db.batch([
    db.prepare(
      `SELECT pi.position, pi.question_id, pi.question_version_id, pi.pick_reason,
              v.html_blob_sha256, v.source_question_number AS qno, v.plain_text,
              q.subject_id, q.difficulty_code, q.answer_format, q.option_labels,
              (SELECT blob_sha256 FROM question_version_asset WHERE question_version_id = v.id AND role = 'stylesheet' LIMIT 1) AS css_sha256,
              (SELECT json_group_array(concept_id) FROM question_concept WHERE question_id = q.id) AS concept_ids,
              EXISTS (SELECT 1 FROM answer_key k WHERE k.question_version_id = v.id AND k.retired_at IS NULL) AS has_key
         FROM paper_item pi
         JOIN question_version v ON v.id = pi.question_version_id
         JOIN question q ON q.id = pi.question_id
        WHERE pi.paper_id = ? ORDER BY pi.position`,
    ).bind(id),
    db.prepare(`SELECT * FROM practice_session WHERE paper_id = ? ORDER BY started_at`).bind(id),
    db.prepare(
      `SELECT a.*, g.result, g.score_permille, g.grade_no, g.error_type_code, g.method
         FROM attempt a LEFT JOIN v_effective_grade g ON g.attempt_id = a.id
        WHERE a.paper_id = ? ORDER BY a.attempted_at`,
    ).bind(id),
  ]);
  return json({ paper, items: items.results, sessions: sessions.results, attempts: attempts.results });
}

export async function paperArchive(env: Env, id: string) {
  await env.DB.prepare(`UPDATE paper SET archived_at = ? WHERE id = ?`).bind(now(), id).run();
  return json({ ok: true });
}

// ------------------------------------------------------------------ practice sessions (FR-4.1)

export async function sessionStart(env: Env, paperId: string) {
  const open = await first(env.DB, `SELECT * FROM practice_session WHERE paper_id = ? AND completed_at IS NULL`, paperId);
  if (open) return json({ session: open });
  const p = await first(env.DB, `SELECT id FROM paper WHERE id = ? AND frozen_at IS NOT NULL`, paperId);
  if (!p) throw new HttpError(404, "Paper not found.");
  const t = now();
  const s = { id: ulid(t), paper_id: paperId, started_at: t, completed_at: null, current_position: 1, current_elapsed_seconds: 0, updated_at: t };
  await env.DB.prepare(`INSERT INTO practice_session (id, paper_id, started_at, current_position, current_elapsed_seconds, updated_at) VALUES (?,?,?,?,?,?)`)
    .bind(s.id, paperId, t, 1, 0, t).run();
  return json({ session: s });
}

export async function sessionPatch(req: Request, env: Env, id: string) {
  const body = await readJson<{ current_position?: number; current_elapsed_seconds?: number; complete?: boolean }>(req);
  const s = await first(env.DB, `SELECT * FROM practice_session WHERE id = ?`, id);
  if (!s) throw new HttpError(404, "Session not found.");
  if (s.completed_at) throw new HttpError(409, "This sitting is already finished.");
  const t = now();
  await env.DB.prepare(
    `UPDATE practice_session SET current_position = ?, current_elapsed_seconds = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
  ).bind(
    Math.max(1, Math.trunc(body.current_position ?? (s.current_position as number))),
    Math.max(0, Math.trunc(body.current_elapsed_seconds ?? (s.current_elapsed_seconds as number))),
    t,
    body.complete ? t : null,
    id,
  ).run();
  return json({ ok: true });
}

// ------------------------------------------------------------------ attempts & grades (FR-4, DR-4/9)

interface GradeIn {
  result: "correct" | "incorrect" | "partial";
  score_permille?: number;
  error_type_code?: string | null;
  confidence?: number | null;
  note?: string | null;
}

function normaliseGrade(g: GradeIn): { result: string; score: number } {
  if (!["correct", "incorrect", "partial"].includes(g?.result)) throw new HttpError(400, "Choose correct, incorrect or partial.");
  if (g.result === "correct") return { result: "correct", score: 1000 };
  if (g.result === "incorrect") return { result: "incorrect", score: 0 };
  const s = Math.round(Number(g.score_permille));
  if (!(s >= 1 && s <= 999)) throw new HttpError(400, "Partial credit must be between 0.1% and 99.9%.");
  return { result: "partial", score: s };
}

function autoGrade(key: Row, resp: { kind: string; options?: string[]; numeric?: number | null }) {
  const type = key.answer_type as string;
  if ((type === "mcq_single" || type === "mcq_multi") && resp.kind === "mcq" && Array.isArray(resp.options)) {
    const want = (JSON.parse(key.mcq_correct as string) as string[]).slice().sort();
    const got = resp.options.slice().sort();
    const ok = want.length === got.length && want.every((v, i) => v === got[i]);
    return { result: ok ? "correct" : "incorrect", score: ok ? 1000 : 0, rule: "mcq_exact_v1" };
  }
  if (type === "numeric" && resp.kind === "numeric" && typeof resp.numeric === "number" && Number.isFinite(resp.numeric)) {
    const ok = Math.abs(resp.numeric - (key.numeric_value as number)) <= (key.numeric_tolerance as number);
    return { result: ok ? "correct" : "incorrect", score: ok ? 1000 : 0, rule: "numeric_tolerance_v1" };
  }
  return null;
}

export async function attemptCreate(req: Request, env: Env) {
  const db = env.DB;
  const body = await readJson<{
    question_id: string;
    question_version_id: string;
    session_id?: string | null;
    paper_position?: number | null;
    local_date: string;
    time_taken_seconds: number;
    response: { kind: "none" | "mcq" | "numeric" | "text"; options?: string[]; numeric?: number | null; text?: string | null };
    grade?: GradeIn;
  }>(req);
  if (!DATE_RE.test(body.local_date ?? "")) throw new HttpError(400, "local_date must be YYYY-MM-DD.");
  const v = await first(db, `SELECT id, question_id FROM question_version WHERE id = ?`, body.question_version_id);
  if (!v || v.question_id !== body.question_id) throw new HttpError(400, "Unknown question version.");

  let paperId: string | null = null;
  let position: number | null = null;
  let itemCount = 0;
  if (body.session_id) {
    const s = await first(db, `SELECT * FROM practice_session WHERE id = ?`, body.session_id);
    if (!s) throw new HttpError(404, "Session not found.");
    if (s.completed_at) throw new HttpError(409, "This sitting is already finished.");
    paperId = s.paper_id as string;
    position = Math.trunc(Number(body.paper_position));
    const item = await first(db, `SELECT question_version_id FROM paper_item WHERE paper_id = ? AND position = ?`, paperId, position);
    if (!item || item.question_version_id !== body.question_version_id) throw new HttpError(400, "That question is not at this position in the paper.");
    itemCount = (await first<{ n: number }>(db, `SELECT count(*) AS n FROM paper_item WHERE paper_id = ?`, paperId))!.n;
  }

  const resp = body.response ?? { kind: "none" };
  if (!["none", "mcq", "numeric", "text"].includes(resp.kind)) throw new HttpError(400, "Unknown response kind.");
  const key = await first(db, `SELECT * FROM answer_key WHERE question_version_id = ? AND retired_at IS NULL`, body.question_version_id);
  const auto = key ? autoGrade(key, resp) : null;
  let result: string, score: number, method: string, rule: string;
  if (auto) {
    ({ result, score, rule } = auto);
    method = "auto";
  } else {
    const g = normaliseGrade(need(body.grade, "Grade the answer first."));
    result = g.result;
    score = g.score;
    method = "manual";
    rule = "manual_v1";
  }
  const t = now();
  const attemptId = ulid(t);
  const gradeId = ulid(t);
  const g = body.grade ?? ({} as GradeIn);
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO attempt (id, question_id, question_version_id, session_id, paper_id, paper_position, attempted_at, local_date,
                            time_taken_seconds, response_kind, response_options, response_numeric, response_text)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      attemptId, body.question_id, body.question_version_id, body.session_id || null, paperId, position, t, body.local_date,
      Math.max(0, Math.trunc(body.time_taken_seconds || 0)), resp.kind,
      resp.kind === "mcq" ? JSON.stringify(resp.options ?? []) : null,
      resp.kind === "numeric" && typeof resp.numeric === "number" ? resp.numeric : null,
      resp.kind === "text" ? (resp.text ?? "") : null,
    ),
    db.prepare(
      `INSERT INTO grade (id, attempt_id, grade_no, cause, result, score_permille, method, scoring_rule_code, answer_key_id,
                          error_type_code, confidence, note, graded_at)
       VALUES (?,?,1,'initial',?,?,?,?,?,?,?,?,?)`,
    ).bind(
      gradeId, attemptId, result, score, method, rule, auto ? key!.id : null,
      g.error_type_code || null, g.confidence ? Math.trunc(g.confidence) : null, g.note?.trim() || null, t,
    ),
    ...liveUpdateStatements(db, body.question_id, body.local_date),
  ];
  if (body.session_id && position) {
    const done = position >= itemCount;
    stmts.push(
      db.prepare(`UPDATE practice_session SET current_position = ?, current_elapsed_seconds = 0, updated_at = ?, completed_at = ? WHERE id = ?`)
        .bind(done ? position : position + 1, t, done ? t : null, body.session_id),
    );
  }
  try {
    await db.batch(stmts); // attempt + grade + metrics in one step (DR-4)
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new HttpError(409, "This question was already answered in this sitting.");
    throw e;
  }
  const solution = await first(db, `SELECT * FROM solution WHERE question_version_id = ? AND retired_at IS NULL`, body.question_version_id);
  return json({ attempt_id: attemptId, grade: { id: gradeId, result, score_permille: score, method, rule }, answer_key: key, solution });
}

export async function gradeCorrect(req: Request, env: Env, attemptId: string) {
  const db = env.DB;
  const body = await readJson<GradeIn>(req);
  const a = await first(db, `SELECT * FROM attempt WHERE id = ?`, attemptId);
  if (!a) throw new HttpError(404, "Attempt not found.");
  const { result, score } = normaliseGrade(body);
  const max = await first<{ m: number }>(db, `SELECT max(grade_no) AS m FROM grade WHERE attempt_id = ?`, attemptId);
  const t = now();
  const id = ulid(t);
  await db.batch([
    db.prepare(
      `INSERT INTO grade (id, attempt_id, grade_no, cause, result, score_permille, method, scoring_rule_code, error_type_code, confidence, note, graded_at)
       VALUES (?,?,?,'correction',?,?,'manual','manual_v1',?,?,?,?)`,
    ).bind(id, attemptId, (max?.m ?? 0) + 1, result, score, body.error_type_code || null,
      body.confidence ? Math.trunc(body.confidence) : null, body.note?.trim() || null, t),
    ...liveUpdateStatements(db, a.question_id as string, a.local_date as string),
  ]);
  return json({ id, result, score_permille: score });
}

// ------------------------------------------------------------------ analytics (FR-5)

export async function analytics(env: Env) {
  const [concept, subject, daily] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM concept_daily_stat ORDER BY local_date`),
    env.DB.prepare(`SELECT * FROM subject_daily_stat ORDER BY local_date`),
    env.DB.prepare(`SELECT * FROM v_daily_activity ORDER BY local_date`),
  ]);
  return json({ concept: concept.results, subject: subject.results, daily: daily.results });
}
