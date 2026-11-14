// Backup, restore and integrity (FR-6.3, FR-6.5, DR-6, DR-12).
import { ulid } from "../shared/ulid";
import { HttpError, json } from "./http";
import { compareMetrics, rebuildAllStatements } from "./metrics";
import type { Env } from "./api";

/** Tables in the order they must be restored (parents before children). Metrics are rebuilt, not restored. */
export const RESTORE_ORDER = [
  "blob", "source_file", "import_batch",
  "subject", "concept", "difficulty",
  "question", "question_version", "question_version_asset", "question_concept",
  "custom_field", "question_field_value",
  "answer_key", "solution", "suggestion",
  "saved_filter", "paper", "paper_item", "practice_session",
  "scoring_rule", "error_type", "attempt", "grade",
  "change_log", "integrity_check_run",
] as const;
// Lookup tables are seeded by the migration, and blob rows are re-created as files upload, so these replace.
const LOOKUP_TABLES = new Set(["difficulty", "scoring_rule", "error_type", "blob"]);
export const EXPORT_TABLES = [...RESTORE_ORDER, "schema_migration", "question_stat", "concept_daily_stat", "subject_daily_stat"];

async function columns(db: D1Database, table: string) {
  return (await db.prepare(`SELECT name, pk FROM pragma_table_info(?)`).bind(table).all<{ name: string; pk: number }>()).results;
}

export async function exportTable(env: Env, table: string, url: URL) {
  if (!EXPORT_TABLES.includes(table)) throw new HttpError(400, "Unknown table.");
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") ?? 2000)));
  const cols = await columns(env.DB, table);
  const order = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  const rows = (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY ${(order.length ? order : ["rowid"]).join(", ")} LIMIT ? OFFSET ?`)
    .bind(limit, offset).all()).results;
  return json({ table, offset, rows, done: rows.length < limit });
}

export function exportInfo() {
  return json({ tables: EXPORT_TABLES, restoreOrder: RESTORE_ORDER });
}

// --- restore: begin (DB must be empty) → table chunks → finish (rebuild + check)

const LOCK_KEY = "system/restore-lock.json";

async function requireLock(req: Request, env: Env) {
  const obj = await env.FILES.get(LOCK_KEY);
  const token = req.headers.get("x-restore-token");
  if (!obj || !token) throw new HttpError(409, "No restore in progress.");
  const lock = (await obj.json()) as { token: string };
  if (lock.token !== token) throw new HttpError(409, "Another restore is in progress.");
}

export async function restoreBegin(env: Env) {
  const counts = await env.DB.prepare(
    `SELECT (SELECT count(*) FROM question) + (SELECT count(*) FROM attempt) + (SELECT count(*) FROM subject) + (SELECT count(*) FROM blob) AS n`,
  ).first<{ n: number }>();
  if ((counts?.n ?? 0) > 0) {
    throw new HttpError(409, "Restore only works into an empty database. Create a fresh database first (see README).");
  }
  const token = ulid();
  await env.FILES.put(LOCK_KEY, JSON.stringify({ token, started_at: Date.now() }));
  return json({ token });
}

/** Body = JSON array of row objects (sent through to D1 untouched, so large chunks cost little CPU). */
export async function restoreTable(req: Request, env: Env, table: string) {
  await requireLock(req, env);
  if (!(RESTORE_ORDER as readonly string[]).includes(table)) throw new HttpError(400, "Unknown table.");
  const text = await req.text();
  if (!text.startsWith("[")) throw new HttpError(400, "Send a JSON array.");
  const cols = (await columns(env.DB, table)).map((c) => c.name);
  const verb = LOOKUP_TABLES.has(table) ? "INSERT OR REPLACE" : "INSERT";
  const sel = cols.map((c) => `json_extract(value, '$."${c}"')`).join(", ");
  const r = await env.DB.batch([
    env.DB.prepare(`PRAGMA defer_foreign_keys = on`),
    env.DB.prepare(`${verb} INTO ${table} (${cols.join(", ")}) SELECT ${sel} FROM json_each(?)`).bind(text),
  ]);
  return json({ table, inserted: r[1].meta.changes });
}

export async function restoreFinish(req: Request, env: Env) {
  await requireLock(req, env);
  await env.DB.batch(rebuildAllStatements(env.DB));
  const report = await integrityCheck(env, "restore");
  await env.FILES.delete(LOCK_KEY);
  return json(report);
}

// --- integrity check (DR-12)

export async function integrityCheck(env: Env, reason: "manual" | "restore" | "migration" | "scheduled") {
  const started = Date.now();
  const db = env.DB;
  const issues: { kind: string; detail: string }[] = [];

  const mismatch = await compareMetrics(db);
  for (const [table, n] of Object.entries(mismatch)) {
    if (n) issues.push({ kind: "metric_mismatch", detail: `${table}: ${n} row(s) differ from a rebuild from history` });
  }

  const [missingAssets, noVersion, noStyle, orphanTags] = await db.batch<{ n: number }>([
    db.prepare(`SELECT count(*) AS n FROM question_version_asset WHERE blob_sha256 IS NULL`),
    db.prepare(`SELECT count(*) AS n FROM question q WHERE NOT EXISTS (SELECT 1 FROM question_version v WHERE v.question_id = q.id)`),
    db.prepare(`SELECT count(*) AS n FROM question_version v WHERE v.content_format = 'html_fragment' AND NOT EXISTS (SELECT 1 FROM question_version_asset a WHERE a.question_version_id = v.id AND a.role = 'stylesheet')`),
    db.prepare(`SELECT count(*) AS n FROM question_concept qc JOIN concept c ON c.id = qc.concept_id WHERE c.archived_at IS NOT NULL`),
  ]);
  if (missingAssets.results[0].n) issues.push({ kind: "missing_asset", detail: `${missingAssets.results[0].n} referenced image/font/style file(s) are missing` });
  if (noVersion.results[0].n) issues.push({ kind: "broken_link", detail: `${noVersion.results[0].n} question(s) have no content version` });
  if (noStyle.results[0].n) issues.push({ kind: "warning", detail: `${noStyle.results[0].n} version(s) have no stylesheet recorded` });
  if (orphanTags.results[0].n) issues.push({ kind: "warning", detail: `${orphanTags.results[0].n} tag(s) point at archived concepts` });

  try {
    const fk = await db.prepare(`PRAGMA foreign_key_check`).all();
    if (fk.results.length) issues.push({ kind: "broken_link", detail: `${fk.results.length} row(s) break a database link` });
  } catch {
    /* not available on every runtime */
  }

  // Every blob row must exist in R2 (and the reverse, as a warning).
  const inDb = new Set((await db.prepare(`SELECT sha256 FROM blob`).all<{ sha256: string }>()).results.map((r) => r.sha256));
  const inR2 = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ prefix: "blob/", cursor, limit: 1000 });
    for (const o of page.objects) inR2.add(o.key.slice(5));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const lost = [...inDb].filter((h) => !inR2.has(h));
  const extra = [...inR2].filter((h) => !inDb.has(h));
  if (lost.length) issues.push({ kind: "missing_file", detail: `${lost.length} file(s) are recorded but missing from storage: ${lost.slice(0, 5).join(", ")}` });
  if (extra.length) issues.push({ kind: "warning", detail: `${extra.length} stored file(s) are not recorded (harmless leftovers from interrupted uploads)` });

  const errors = issues.filter((i) => i.kind !== "warning").length;
  const report = { issues, errors, checked_files: inDb.size, metrics: mismatch };
  const finished = Date.now();
  await db.prepare(`INSERT INTO integrity_check_run (id, reason, started_at, finished_at, issue_count, report) VALUES (?,?,?,?,?,?)`)
    .bind(ulid(finished), reason, started, finished, errors, JSON.stringify(report)).run();
  return report;
}

export async function rebuildMetrics(env: Env) {
  const before = await compareMetrics(env.DB);
  await env.DB.batch(rebuildAllStatements(env.DB));
  const after = await compareMetrics(env.DB);
  return json({ mismatches_before: before, mismatches_after: after });
}
