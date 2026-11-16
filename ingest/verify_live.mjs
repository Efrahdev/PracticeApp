#!/usr/bin/env node
// Step 3 check (READ-ONLY): after import_live.mjs, read every imported question back from the LIVE database and file
// store and compare it with what the app's importer prepared locally from the same pack files.
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node ingest/verify_live.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://practice-app.aarhaan22.workers.dev";
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => realFetch(typeof url === "string" && url.startsWith("/") ? BASE + url : url, init);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qverify-"));
fs.writeFileSync(path.join(tmp, "e.ts"), `export * from ${JSON.stringify(ROOT + "/src/client/importer.ts")};
export { api } from ${JSON.stringify(ROOT + "/src/client/api.ts")};
export { answerFormatOf } from ${JSON.stringify(ROOT + "/src/shared/qpack/compose.ts")};`);
await build({ entryPoints: [path.join(tmp, "e.ts")], bundle: true, format: "esm", platform: "node", outfile: path.join(tmp, "i.mjs"), logLevel: "silent", nodePaths: [ROOT + "/node_modules"] });
const I = await import(pathToFileURL(path.join(tmp, "i.mjs")).href);

const wr = fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
const DB = wr.match(/"database_id":\s*"([^"]+)"/)[1];
const ACC = (await (await realFetch("https://api.cloudflare.com/client/v4/accounts")).json()).result[0].id;
async function sql(q, params = []) {
  const r = await (await realFetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/d1/database/${DB}/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: q, params }) })).json();
  if (!r.success) throw new Error(JSON.stringify(r.errors));
  return r.result[0].results;
}

const boot = await I.api("GET", "/api/bootstrap");
const subjById = new Map(boot.subjects.map((s) => [s.id, s.name]));
const concepts = await sql("SELECT id, parent_id, name FROM concept");
const cById = new Map(concepts.map((c) => [c.id, c]));
const cPath = (id) => { const out = []; for (let c = cById.get(id); c; c = cById.get(c.parent_id)) out.unshift(c.name); return out.join(" > "); };
const diffByLabel = new Map(boot.difficulties.map((d) => [d.label, d.code]));

const files = fs.readdirSync(path.join(ROOT, "ingest/packs")).filter((f) => f.endsWith(".json")).sort();
const { packs } = await I.readInputs(files.map((f) => new File([fs.readFileSync(path.join(ROOT, "ingest/packs", f))], f)), null);
const problems = [];
const bad = (where, msg) => problems.push(`${where}: ${msg}`);
const allBlobs = new Map(); // sha -> expected text (or null = existence only)
let checked = 0;

for (const p of packs) {
  const like = p.pack.key + "/%";
  const rows = await sql(`SELECT q.id, q.external_ref ref, q.subject_id, q.difficulty_code, q.answer_format, q.option_labels, q.notes, q.archived_at,
      v.id vid, v.version_no, v.content_sha256, v.html_blob_sha256, v.source_question_number, b.label
    FROM question q JOIN question_version v ON v.question_id = q.id JOIN import_batch b ON b.id = v.import_batch_id WHERE q.external_ref LIKE ?`, [like]);
  const byRef = new Map(rows.map((r) => [r.ref, r]));
  const keys = await sql(`SELECT q.external_ref ref, k.* FROM answer_key k JOIN question_version v ON v.id = k.question_version_id JOIN question q ON q.id = v.question_id WHERE q.external_ref LIKE ? AND k.retired_at IS NULL`, [like]);
  const sols = await sql(`SELECT q.external_ref ref, s.body_text, s.body_blob_sha256, s.body_format, s.origin FROM solution s JOIN question_version v ON v.id = s.question_version_id JOIN question q ON q.id = v.question_id WHERE q.external_ref LIKE ? AND s.retired_at IS NULL`, [like]);
  const qc = await sql(`SELECT q.external_ref ref, qc.concept_id, qc.weight FROM question_concept qc JOIN question q ON q.id = qc.question_id WHERE q.external_ref LIKE ?`, [like]);
  const fv = await sql(`SELECT q.external_ref ref, f.name, f.data_type, v.value_text, v.value_number, v.value_bool, v.value_date FROM question_field_value v JOIN custom_field f ON f.id = v.field_id JOIN question q ON q.id = v.question_id WHERE q.external_ref LIKE ?`, [like]);
  const assets = await sql(`SELECT q.external_ref ref, a.original_ref, a.blob_sha256 FROM question_version_asset a JOIN question_version v ON v.id = a.question_version_id JOIN question q ON q.id = v.question_id WHERE q.external_ref LIKE ?`, [like]);
  const group = (arr) => arr.reduce((m, r) => (m.get(r.ref) ?? m.set(r.ref, []).get(r.ref)).push(r) && m, new Map());
  const K = group(keys), S = group(sols), C = group(qc), F = group(fv), A = group(assets);

  if (rows.length !== p.questions.length) bad(p.sourceName, `${rows.length} questions in the library, ${p.questions.length} in the pack`);
  allBlobs.set(p.sourceSha, null);
  for (const q of p.questions) {
    const ref = q.nq.ref, r = byRef.get(ref), w = `${p.pack.key} ${q.nq.id}`;
    checked++;
    if (!r) { bad(w, "missing from the library"); continue; }
    const eq = (what, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) bad(w, `${what}: library ${JSON.stringify(a)?.slice(0, 120)} vs pack ${JSON.stringify(b)?.slice(0, 120)}`); };
    eq("version", r.version_no, 1); eq("archived", r.archived_at, null);
    eq("content fingerprint", r.content_sha256, q.contentSha);
    eq("stored record", r.html_blob_sha256, q.blobSha);
    eq("number", r.source_question_number, q.nq.number ?? "");
    eq("subject", subjById.get(r.subject_id), q.nq.subject);
    eq("difficulty", r.difficulty_code, q.nq.difficulty ? diffByLabel.get(q.nq.difficulty) : null);
    eq("answer format", r.answer_format, I.answerFormatOf(q.nq.type));
    eq("option labels", r.option_labels ? JSON.parse(r.option_labels) : null, q.nq.options.length ? q.nq.options.map((o) => o.label) : null);
    eq("notes", r.notes, q.nq.notes);
    eq("import name", r.label, p.label || null);
    // answer key
    const k = K.get(ref) ?? [];
    if (!q.key) eq("answer key count", k.length, 0);
    else {
      eq("answer key count", k.length, 1);
      if (k[0]) {
        eq("answer type", k[0].answer_type, q.key.answer_type);
        if (q.key.mcq_correct) eq("mcq key", JSON.parse(k[0].mcq_correct), q.key.mcq_correct);
        if (q.key.numeric_value !== undefined) eq("numeric key", k[0].numeric_value, q.key.numeric_value);
        if (q.key.text_value !== undefined) eq("text key", k[0].text_value, q.key.text_value);
      }
    }
    // solution
    const s = S.get(ref) ?? [];
    if (!q.solution) eq("solution count", s.length, 0);
    else {
      eq("solution count", s.length, 1);
      if (s[0]) {
        eq("solution format", s[0].body_format, q.solution.format);
        if (s[0].body_text !== null) eq("solution text", s[0].body_text, q.solution.body);
        else { allBlobs.set(s[0].body_blob_sha256, q.solution.body); }
      }
    }
    // topics
    eq("topics", (C.get(ref) ?? []).map((c) => cPath(c.concept_id)).sort(), q.nq.topics.map((t) => t.path.join(" > ")).sort());
    // fields
    const got = Object.fromEntries((F.get(ref) ?? []).map((f) => [f.name, f.value_text ?? f.value_number ?? (f.value_bool === null ? f.value_date : !!f.value_bool)]));
    eq("fields", Object.fromEntries(Object.entries(got).sort()), Object.fromEntries(Object.entries(q.nq.fields).sort()));
    // images
    eq("images", (A.get(ref) ?? []).map((a) => [a.original_ref, a.blob_sha256]).sort(), q.assets.map((a) => [a.ref, a.blob_sha256]).sort());
    allBlobs.set(q.blobSha, q.storedJson);
    for (const a of q.assets) if (a.blob_sha256) allBlobs.set(a.blob_sha256, null);
  }
}

// files: all present, and every stored question record / image re-hashes to its name
const { missing } = await I.api("POST", "/api/blobs/check", { hashes: [...allBlobs.keys()] });
if (missing.length) bad("files", `${missing.length} missing from storage, e.g. ${missing[0]}`);
let fetched = 0;
const shas = [...allBlobs.keys()].filter((h) => !missing.includes(h));
for (let i = 0; i < shas.length; i += 8) {
  await Promise.all(shas.slice(i, i + 8).map(async (h) => {
    const buf = Buffer.from(await (await realFetch(`${BASE}/api/blobs/${h}`)).arrayBuffer());
    fetched++;
    if (crypto.createHash("sha256").update(buf).digest("hex") !== h) bad("files", `${h} content does not match its fingerprint`);
    const want = allBlobs.get(h);
    if (want !== null && buf.toString("utf8") !== want) bad("files", `${h} differs from the prepared record`);
  }));
}
console.log(`checked ${checked} questions and ${fetched} stored files`);
console.log(problems.length ? `PROBLEMS (${problems.length}):\n  ` + problems.slice(0, Number(process.env.SHOW ?? 30)).join("\n  ") : "LIVE LIBRARY MATCHES THE PACKS EXACTLY");
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(problems.length ? 1 : 0);
