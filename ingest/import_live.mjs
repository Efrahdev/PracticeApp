#!/usr/bin/env node
// Step 3: import the reviewed packs into the LIVE library using the app's OWN importer (src/client/importer.ts, unchanged):
// the same read -> preview -> upload files -> commit path the Import screen runs, with the Import screen's default mapping.
//
//   node ingest/import_live.mjs                 dry run: read + server preview only, writes nothing
//   node ingest/import_live.mjs --commit [--only <pack-file>]...
//
// Safeguards: aborts unless every question parses without errors, is "new" in the live library, and every subject /
// difficulty label maps to an EXISTING one. Before writing it records a D1 Time Travel bookmark (restore point) in
// ingest/live-import-log.json. Run with NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt in this sandbox.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://practice-app.aarhaan22.workers.dev";
const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const only = args.flatMap((a, i) => (args[i - 1] === "--only" ? [a] : []));

// relative API paths -> live origin (the importer calls fetch("/api/..."))
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => realFetch(typeof url === "string" && url.startsWith("/") ? BASE + url : url, init);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qimport-"));
fs.writeFileSync(path.join(tmp, "e.ts"), `export * from ${JSON.stringify(ROOT + "/src/client/importer.ts")};
export { api } from ${JSON.stringify(ROOT + "/src/client/api.ts")};`);
await build({ entryPoints: [path.join(tmp, "e.ts")], bundle: true, format: "esm", platform: "node", outfile: path.join(tmp, "i.mjs"), logLevel: "silent", nodePaths: [ROOT + "/node_modules"] });
const I = await import(pathToFileURL(path.join(tmp, "i.mjs")).href);

const die = (msg) => { console.error("ABORT: " + msg); process.exit(2); };
const boot = await I.api("GET", "/api/bootstrap");
if (boot.schemaVersion !== 3) die(`live schema version ${boot.schemaVersion}, expected 3`);

const files = fs.readdirSync(path.join(ROOT, "ingest/packs")).filter((f) => f.endsWith(".json")).filter((f) => !only.length || only.includes(f)).sort();
if (!files.length) die("no packs selected");
const fileObjs = files.map((f) => new File([fs.readFileSync(path.join(ROOT, "ingest/packs", f))], f, { type: "application/json" }));
const { packs, failures } = await I.readInputs(fileObjs, null);
if (failures.length) die("unreadable: " + JSON.stringify(failures));

// ---- same default mapping as src/client/pages/Import.tsx
const subjects = new Map(), diffs = new Map();
for (const p of packs) for (const q of p.questions) {
  const s = q.nq.subject ?? "";
  if (!subjects.has(s)) {
    const hit = boot.subjects.find((x) => !x.archived_at && x.name.toLowerCase() === s.toLowerCase());
    if (!hit) die(`subject "${s}" (${p.sourceName} ${q.nq.id}) does not exist in the library`);
    subjects.set(s, { id: hit.id });
  }
  if (q.nq.difficulty && !diffs.has(q.nq.difficulty)) {
    const c = I.suggestDifficulty(q.nq.difficulty, boot.difficulties);
    if (!c || !("code" in c)) die(`difficulty "${q.nq.difficulty}" would create a new label`);
    diffs.set(q.nq.difficulty, c);
  }
}

// ---- read + preview
let total = 0;
for (const p of packs) {
  const errs = p.questions.filter((q) => q.errors.length);
  if (errs.length) die(`${p.sourceName}: ${errs.length} question(s) with errors: ${errs[0].errors}`);
  await I.preview(p);
  const st = p.questions.reduce((m, q) => ((m[q.status] = (m[q.status] || 0) + 1), m), {});
  const warn = p.questions.flatMap((q) => q.warnings).reduce((m, w) => ((m[w] = (m[w] || 0) + 1), m), {});
  console.log(`${p.sourceName}: ${p.questions.length} questions | status ${JSON.stringify(st)} | files ${p.assetBlobs.size} | warnings ${JSON.stringify(warn)}`);
  if (p.questions.some((q) => q.status !== "new")) die(`${p.sourceName}: not every question is new — refusing to import`);
  if (!p.questions.every((q) => q.include)) die(`${p.sourceName}: some questions would be skipped`);
  total += p.questions.length;
}
console.log(`mapping: subjects ${JSON.stringify([...subjects])} | difficulties ${JSON.stringify([...diffs])}`);
console.log(`fields: ${JSON.stringify([...I.fieldTypes(packs, boot.fields)])}`);
if (!COMMIT) { console.log(`\nDRY RUN OK: ${total} questions in ${packs.length} pack(s) would be imported as new. Nothing was written.`); process.exit(0); }

// ---- restore point, then commit
const wr = fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
const DB = wr.match(/"database_id":\s*"([^"]+)"/)[1];
const acc = (await (await realFetch("https://api.cloudflare.com/client/v4/accounts")).json()).result[0].id;
const bm = await (await realFetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/d1/database/${DB}/time_travel/bookmark`)).json();
if (!bm.success || !bm.result?.bookmark) die("could not record a D1 Time Travel restore point: " + JSON.stringify(bm.errors));
const logPath = path.join(ROOT, "ingest/live-import-log.json");
const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, "utf8")) : [];
const entry = { started: new Date().toISOString(), restore_bookmark: bm.result.bookmark, restore_command: `npx wrangler d1 time-travel restore practice-app-db --bookmark=${bm.result.bookmark}`, packs: files, results: null };
log.push(entry); fs.writeFileSync(logPath, JSON.stringify(log, null, 2) + "\n");
console.log(`restore point recorded: ${bm.result.bookmark}`);

const mapping = { subjects, difficulties: diffs, updateExisting: false };
const res = await I.commitPacks(packs, mapping, I.fieldTypes(packs, boot.fields), (m) => process.stdout.write(`\r  ${m.padEnd(70)}`));
console.log();
entry.finished = new Date().toISOString(); entry.results = res;
fs.writeFileSync(logPath, JSON.stringify(log, null, 2) + "\n");
for (const r of res) console.log(`${r.pack}: new ${r.new}, new versions ${r.new_versions}, duplicates ${r.duplicates}, rejected ${r.rejected}`);
const bad = res.filter((r, i) => r.new !== packs[i].questions.length || r.rejected || r.duplicates || r.new_versions);
if (bad.length) die("commit result does not match the packs: " + JSON.stringify(bad));
console.log(`\nCOMMITTED: ${res.reduce((n, r) => n + r.new, 0)} new questions.`);
fs.rmSync(tmp, { recursive: true, force: true });
