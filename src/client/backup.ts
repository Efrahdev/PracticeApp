// Export / restore (FR-6.3–6.5). The archive is built and checked on the device,
// so the Worker never does heavy work. Layout:
//   manifest.json, checksums.sha256, db/<table>.json, blobs/<sha256>, csv/*.csv
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { api, sha256HexBytes } from "./api";

type Row = Record<string, any>;

async function pool<T>(items: T[], n: number, fn: (t: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k], k);
    }
  }));
}

function csv(rows: Row[], cols: string[]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n");
}

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : "");

export async function exportArchive(onProgress: (msg: string, frac: number) => void): Promise<Blob> {
  const info = await api<{ tables: string[] }>("GET", "/api/export");
  const tables: Record<string, Row[]> = {};
  for (const [i, t] of info.tables.entries()) {
    onProgress(`Reading ${t}…`, (0.3 * i) / info.tables.length);
    const rows: Row[] = [];
    for (let offset = 0; ; ) {
      const page = await api<{ rows: Row[]; done: boolean }>("GET", `/api/export/${t}?offset=${offset}&limit=2000`);
      rows.push(...page.rows);
      offset += page.rows.length;
      if (page.done) break;
    }
    tables[t] = rows;
  }
  const files: Record<string, Uint8Array> = {};
  for (const [t, rows] of Object.entries(tables)) files[`db/${t}.json`] = strToU8(JSON.stringify(rows));

  const blobs = tables.blob ?? [];
  let n = 0;
  await pool(blobs, 6, async (b) => {
    const res = await fetch(`/api/blobs/${b.sha256}`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`File ${b.sha256.slice(0, 12)}… could not be read (${res.status}).`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if ((await sha256HexBytes(bytes)) !== b.sha256) throw new Error(`File ${b.sha256.slice(0, 12)}… is damaged in storage.`);
    files[`blobs/${b.sha256}`] = bytes;
    onProgress(`Copying files… ${++n}/${blobs.length}`, 0.3 + (0.6 * n) / Math.max(1, blobs.length));
  });

  // Spreadsheet-friendly copies (FR-6.4).
  const eff = new Map<string, Row>();
  for (const g of tables.grade ?? []) {
    const cur = eff.get(g.attempt_id);
    if (!cur || g.grade_no > cur.grade_no) eff.set(g.attempt_id, g);
  }
  const attemptsCsv = (tables.attempt ?? []).map((a) => {
    const g = eff.get(a.id);
    return {
      attempt_id: a.id, question_id: a.question_id, question_version_id: a.question_version_id, paper_id: a.paper_id,
      attempted_at_utc: iso(a.attempted_at), local_date: a.local_date, time_taken_seconds: a.time_taken_seconds,
      response: a.response_kind === "mcq" ? a.response_options : a.response_kind === "numeric" ? a.response_numeric : a.response_text,
      result: g?.result, score_percent: g ? g.score_permille / 10 : "", graded_by: g?.method, error_type: g?.error_type_code,
      confidence: g?.confidence, note: g?.note,
    };
  });
  const verByQ = new Map<string, Row>();
  for (const v of tables.question_version ?? []) {
    const cur = verByQ.get(v.question_id);
    if (!cur || v.version_no > cur.version_no) verByQ.set(v.question_id, v);
  }
  const subj = new Map((tables.subject ?? []).map((s) => [s.id, s.name]));
  const conc = new Map((tables.concept ?? []).map((c) => [c.id, c.name]));
  const tags = new Map<string, string[]>();
  for (const t of tables.question_concept ?? []) tags.set(t.question_id, [...(tags.get(t.question_id) ?? []), `${conc.get(t.concept_id)} (${t.weight})`]);
  const stats = new Map((tables.question_stat ?? []).map((s) => [s.question_id, s]));
  const questionsCsv = (tables.question ?? []).map((q) => {
    const v = verByQ.get(q.id);
    const s = stats.get(q.id);
    return {
      question_id: q.id, question_number: v?.source_question_number, version: v?.version_no, subject: subj.get(q.subject_id) ?? "",
      difficulty: q.difficulty_code, concepts: (tags.get(q.id) ?? []).join("; "), answer_format: q.answer_format,
      attempts: s?.attempt_count ?? 0, last_result: s?.last_result ?? "", last_attempted_utc: iso(s?.last_attempted_at ?? null),
      average_time_seconds: s ? Math.round(s.total_time_seconds / s.attempt_count) : "", archived: q.archived_at ? "yes" : "no",
      text: v?.plain_text,
    };
  });
  files["csv/attempts.csv"] = strToU8(csv(attemptsCsv, Object.keys(attemptsCsv[0] ?? { attempt_id: 1 })));
  files["csv/questions.csv"] = strToU8(csv(questionsCsv, Object.keys(questionsCsv[0] ?? { question_id: 1 })));

  onProgress("Writing checksums…", 0.93);
  const sums: string[] = [];
  for (const path of Object.keys(files).sort()) sums.push(`${await sha256HexBytes(files[path])}  ${path}`);
  const manifest = {
    app: "practice-app",
    format: 1,
    schema_version: (tables.schema_migration ?? []).reduce((m, r) => Math.max(m, r.version), 0),
    exported_at_utc: new Date().toISOString(),
    counts: Object.fromEntries(Object.entries(tables).map(([t, r]) => [t, r.length])),
    files: Object.keys(files).length,
  };
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  sums.push(`${await sha256HexBytes(files["manifest.json"])}  manifest.json`);
  files["checksums.sha256"] = strToU8(sums.join("\n") + "\n");
  onProgress("Compressing…", 0.97);
  const zip = zipSync(files, { level: 6 });
  onProgress("Done", 1);
  return new Blob([zip], { type: "application/zip" });
}

export interface VerifyReport { ok: boolean; problems: string[]; manifest: any; files: Record<string, Uint8Array> }

export async function verifyArchive(buf: ArrayBuffer): Promise<VerifyReport> {
  const problems: string[] = [];
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buf));
  } catch {
    return { ok: false, problems: ["This is not a readable zip archive."], manifest: null, files: {} };
  }
  const sums = files["checksums.sha256"] ? strFromU8(files["checksums.sha256"]) : "";
  if (!sums) problems.push("checksums.sha256 is missing.");
  const listed = new Set<string>();
  for (const line of sums.split("\n").filter(Boolean)) {
    const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (!m) { problems.push(`Bad checksum line: ${line.slice(0, 60)}`); continue; }
    listed.add(m[2]);
    const f = files[m[2]];
    if (!f) problems.push(`Missing from archive: ${m[2]}`);
    else if ((await sha256HexBytes(f)) !== m[1]) problems.push(`Changed or damaged: ${m[2]}`);
  }
  for (const path of Object.keys(files)) {
    if (path !== "checksums.sha256" && !listed.has(path) && !path.endsWith("/")) problems.push(`Not in checksum list: ${path}`);
    if (path.startsWith("blobs/") && files[path] && (await sha256HexBytes(files[path])) !== path.slice(6)) problems.push(`File name does not match content: ${path}`);
  }
  const manifest = files["manifest.json"] ? JSON.parse(strFromU8(files["manifest.json"])) : null;
  if (!manifest || manifest.app !== "practice-app") problems.push("manifest.json is missing or not from this app.");
  return { ok: problems.length === 0, problems, manifest, files };
}

function topoConcepts(rows: Row[]): Row[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Row[] = [];
  const seen = new Set<string>();
  const visit = (r: Row) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    for (const ref of [r.parent_id, r.merged_into_id]) if (ref && byId.has(ref)) visit(byId.get(ref)!);
    out.push(r);
  };
  rows.forEach(visit);
  return out;
}

export async function restoreArchive(rep: VerifyReport, onProgress: (msg: string, frac: number) => void) {
  if (!rep.ok) throw new Error("The archive failed its checks; nothing was restored.");
  const info = await api<{ restoreOrder: string[] }>("GET", "/api/export");
  const { token } = await api<{ token: string }>("POST", "/api/admin/restore/begin");
  const hdr = { "x-restore-token": token };
  const read = (t: string): Row[] => (rep.files[`db/${t}.json`] ? JSON.parse(strFromU8(rep.files[`db/${t}.json`])) : []);

  const blobRows = read("blob");
  let n = 0;
  await pool(blobRows, 4, async (b) => {
    const bytes = rep.files[`blobs/${b.sha256}`];
    if (!bytes) throw new Error(`Archive is missing file ${b.sha256}`);
    await api("PUT", `/api/blobs/${b.sha256}?mime=${encodeURIComponent(b.mime_type)}`, bytes);
    onProgress(`Uploading files… ${++n}/${blobRows.length}`, (0.6 * n) / Math.max(1, blobRows.length));
  });

  for (const [i, t] of info.restoreOrder.entries()) {
    let rows = read(t);
    if (t === "concept") rows = topoConcepts(rows);
    onProgress(`Restoring ${t}…`, 0.6 + (0.3 * i) / info.restoreOrder.length);
    let chunk: Row[] = [];
    let size = 0;
    const flush = async () => {
      if (!chunk.length) return;
      await api("POST", `/api/admin/restore/table/${t}`, JSON.stringify(chunk), { ...hdr, "content-type": "application/json" });
      chunk = [];
      size = 0;
    };
    for (const r of rows) {
      const s = JSON.stringify(r).length;
      if (size + s > 700_000 || chunk.length >= 2000) await flush();
      chunk.push(r);
      size += s;
    }
    await flush();
  }
  onProgress("Rebuilding analytics and checking…", 0.95);
  const report = await api("POST", "/api/admin/restore/finish", undefined, hdr);
  onProgress("Done", 1);
  return report as { issues: { kind: string; detail: string }[]; errors: number };
}
